/**
 * Simulacra Orchestrator — main entry point.
 *
 * The orchestrator is a dumb TypeScript process. It:
 *   - Watches state/tasks/ for file changes
 *   - Evaluates the transition table on every change
 *   - Applies any pending transitions (writes frontmatter)
 *   - Starts and stops agents in response to transitions
 *   - Runs the DriftMonitor to detect persona drift
 *   - Runs crash recovery on startup
 *   - Runs the scheduler on a poll interval
 *
 * It never makes decisions. It only reads state and applies typed rules.
 */
import path from "path";
import { promises as fs } from "fs";
import yaml from "js-yaml";
import { Watcher } from "./io/watcher.js";
import { readFile } from "./io/fileStore.js";
import { applyPendingTransition } from "./workflow/taskPipeline.js";
import { DriftMonitor } from "./services/driftMonitor.js";
import { recoverCrashedAgents } from "./recovery.js";
import { runSchedulerCycle } from "./scheduler.js";
import {
  spawnCouncilForCompound,
  spawnCouncilForReview,
  spawnCouncilForPeerReview,
  spawnCouncilForResearchReview,
} from "./agents/council.js";
import { spawnStewardForReview, spawnStewardForFinalSignOff } from "./agents/steward.js";
import { spawnResearchAgentForTask } from "./agents/researchAgent.js";
import { writeDriftLearning } from "./learning/councilLearning.js";
import { ApprovalConsole } from "./io/approvalConsole.js";
import { activateProject, setProjectStatus } from "./workflow/onboarding.js";
import { activateKickoffTasks, cancelKickoffTasks } from "./workflow/taskCreation.js";
import { parseAgentLogLines, printAgentLogLine } from "./io/agentLog.js";
import type { AgentLogRole } from "./io/agentLog.js";
import { randomUUID } from "crypto";
import type {
  TaskStatus,
  TaskFrontmatter,
  AgentResult,
  DriftEvent,
} from "./types/index.js";
import { readMarkdownFile, writeMarkdownFile } from "./io/fileStore.js";

// ── Configuration ─────────────────────────────────────────────────────────────

interface OrchestratorConfig {
  readonly orchestrator: { readonly poll_interval_ms: number };
  readonly ui?: {
    readonly enabled: boolean;
    readonly port?: number;
  };
  readonly drift: {
    readonly thresholds: {
      readonly nominal_max: number;
      readonly monitor_max: number;
      readonly reinject_max: number;
    };
  };
  readonly mcp_servers: Record<
    string,
    { readonly command: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>> }
  >;
  readonly paths: {
    readonly roles_dir: string;
    readonly state_dir: string;
  };
}

interface RolesConfig {
  readonly roles: Record<
    string,
    { readonly permitted_mcps: readonly string[]; readonly check_interval_tool_uses: number }
  >;
  readonly crafter_types: Record<string, { readonly additional_mcps: readonly string[] }>;
}

async function loadConfig(): Promise<OrchestratorConfig> {
  const raw = await readFile("config/simulacra.yaml");
  if (raw === null) {
    throw new Error(
      "config/simulacra.yaml not found. Copy config/simulacra.example.yaml and fill in your values.",
    );
  }
  return yaml.load(raw) as OrchestratorConfig;
}

async function loadRolesConfig(): Promise<RolesConfig> {
  const raw = await readFile("config/roles.yaml");
  if (raw === null) throw new Error("config/roles.yaml not found.");
  return yaml.load(raw) as RolesConfig;
}

// ── Task Recovery Helpers ─────────────────────────────────────────────────────

/**
 * Reset a task to blocked after an agent failure.
 * Clears assigned_crafter so the scheduler can reassign after manual triage.
 */
async function resetTaskToBlocked(filePath: string, agentId: string): Promise<void> {
  const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
  if (doc === null) {
    console.error(`[Orchestrator] resetTaskToBlocked: could not read ${filePath}`);
    return;
  }
  const updated: TaskFrontmatter = {
    ...doc.frontmatter,
    status: "blocked",
    assigned_crafter: null,
    updated_at: new Date().toISOString(),
  };
  await writeMarkdownFile(filePath, updated, doc.body);
  console.warn(`[Orchestrator] Task ${filePath} reset to blocked after agent ${agentId} failure.`);
}

/**
 * Build a per-spawn exit handler that captures the task file path.
 * On non-zero exit, resets the task to blocked for manual triage.
 */
function makeExitHandler(filePath: string) {
  return async (result: AgentResult): Promise<void> => {
    if (!result.success) {
      console.error(
        `[Orchestrator] Agent ${result.agent_id} failed (exit ${result.exit_code}). Check logs/${result.agent_id}.log`,
      );
      await resetTaskToBlocked(filePath, result.agent_id);
    }
  };
}

// ── Transition Handlers ───────────────────────────────────────────────────────

/**
 * Called by the orchestrator after each state transition.
 * Decides what to do next based on the new status.
 */
async function handleTransition(
  taskFilePath: string,
  newStatus: TaskStatus,
  config: OrchestratorConfig,
  rolesConfig: RolesConfig,
  spawnDeps: { rolesConfig: RolesConfig; simulacraConfig: OrchestratorConfig },
): Promise<void> {
  const doc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
  if (doc === null) return;

  const { frontmatter } = doc;
  const projectPath = frontmatter.project_path ?? process.cwd();

  const onExit = makeExitHandler(taskFilePath);

  switch (newStatus) {
    case "research_pending": {
      const researchId = `research-${randomUUID()}`;
      await spawnResearchAgentForTask(
        taskFilePath,
        frontmatter.project,
        researchId,
        spawnDeps,
        onExit,
      );
      break;
    }

    case "research_review": {
      const councilId = `council-${randomUUID()}`;
      await spawnCouncilForResearchReview(
        taskFilePath,
        frontmatter.project,
        projectPath,
        councilId,
        spawnDeps,
        onExit,
      );
      break;
    }

    case "steward_review": {
      const stewardId = `steward-${randomUUID()}`;
      // Write assigned_steward to frontmatter so steward_final → compound can validate it
      const stewardDoc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
      if (stewardDoc !== null) {
        await writeMarkdownFile(taskFilePath, {
          ...stewardDoc.frontmatter,
          assigned_steward: stewardId,
          updated_at: new Date().toISOString(),
        }, stewardDoc.body);
      }
      await spawnStewardForReview(
        taskFilePath,
        frontmatter.project,
        projectPath,
        stewardId,
        spawnDeps,
        onExit,
      );
      break;
    }

    case "steward_final": {
      const crafterAgentId = frontmatter.assigned_crafter ?? "unknown";
      const stewardId = `steward-${randomUUID()}`;
      await spawnStewardForFinalSignOff(
        taskFilePath,
        frontmatter.project,
        projectPath,
        crafterAgentId,
        stewardId,
        spawnDeps,
        onExit,
      );
      break;
    }

    case "compound": {
      const councilId = frontmatter.assigned_council_author ?? `council-${randomUUID()}`;
      await spawnCouncilForCompound(
        taskFilePath,
        frontmatter.project,
        projectPath,
        councilId,
        spawnDeps,
        onExit,
      );
      break;
    }

    case "council_review": {
      const authorId = frontmatter.assigned_council_author ?? `council-${randomUUID()}`;
      await spawnCouncilForReview(
        taskFilePath,
        frontmatter.project,
        projectPath,
        authorId,
        spawnDeps,
        onExit,
      );
      break;
    }

    case "council_peer_review": {
      const peerId = frontmatter.assigned_council_peer ?? `council-${randomUUID()}`;
      await spawnCouncilForPeerReview(
        taskFilePath,
        frontmatter.project,
        projectPath,
        peerId,
        spawnDeps,
        onExit,
      );
      break;
    }

    case "done":
      console.log(`[Orchestrator] Task complete: ${taskFilePath}`);
      break;

    case "drift_detected":
      console.warn(`[Orchestrator] Drift detected in task: ${taskFilePath}`);
      break;

    default:
      // Other transitions (in_progress, crafter_revision, etc.) need no
      // orchestrator action beyond the frontmatter update already applied.
      break;
  }
}

// ── Drift Handler ─────────────────────────────────────────────────────────────

async function handleDriftEvent(event: DriftEvent): Promise<void> {
  console.log(
    `[DriftMonitor] Agent ${event.agent_id}: score=${event.score.toFixed(3)} severity=${event.severity} action=${event.action_taken}`,
  );

  if (event.action_taken === "halt_and_reset") {
    console.error(
      `[Orchestrator] HALT — agent ${event.agent_id} has drifted critically. Manual intervention required.`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Agent Log Helpers ─────────────────────────────────────────────────────────

/** Per-task body offsets so we only emit new PHASE/DECISION lines, not historical ones. */
const emittedBodyOffsets = new Map<string, number>();

function statusToLogRole(status: TaskStatus): AgentLogRole {
  if (status === "research_pending") return "research";
  if (status === "research_review") return "council";
  if (status === "in_progress" || status === "crafter_revision" || status === "assigned") {
    return "crafter";
  }
  if (status === "steward_review" || status === "steward_final") return "steward";
  if (status === "council_peer_review") return "council";
  return "council";
}

function getActiveAgentId(frontmatter: TaskFrontmatter, status: TaskStatus): string {
  if (status === "in_progress" || status === "crafter_revision" || status === "assigned") {
    return frontmatter.assigned_crafter ?? "unknown";
  }
  if (status === "steward_review" || status === "steward_final") {
    return frontmatter.assigned_steward ?? "unknown";
  }
  if (status === "council_peer_review") {
    return frontmatter.assigned_council_peer ?? "unknown";
  }
  return frontmatter.assigned_council_author ?? "unknown";
}

async function emitAgentLogLines(filePath: string): Promise<void> {
  const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
  if (doc === null) return;

  const previousOffset = emittedBodyOffsets.get(filePath) ?? 0;
  const newContent = doc.body.slice(previousOffset);
  const lines = parseAgentLogLines(newContent);

  if (lines.length > 0) {
    const role = statusToLogRole(doc.frontmatter.status);
    const agentId = getActiveAgentId(doc.frontmatter, doc.frontmatter.status);
    for (const line of lines) {
      printAgentLogLine(role, agentId, doc.frontmatter.id, line);
    }
  }

  emittedBodyOffsets.set(filePath, doc.body.length);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Prepend HH:MM:SS to every console line for the lifetime of this process
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const ts = (): string => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `\x1b[90m${hh}:${mm}:${ss}\x1b[0m`; // grey timestamp
  };
  console.log = (...args: unknown[]) => { origLog(ts(), ...args); };
  console.warn = (...args: unknown[]) => { origWarn(ts(), ...args); };
  console.error = (...args: unknown[]) => { origError(ts(), ...args); };

  console.log("[Orchestrator] Starting Simulacra...");

  const config = await loadConfig();
  const rolesConfig = await loadRolesConfig();

  const spawnDeps = {
    rolesConfig,
    simulacraConfig: config,
  };

  // 1. Crash recovery
  const crashed = await recoverCrashedAgents();
  if (crashed.length > 0) {
    console.warn(`[Orchestrator] Recovered ${crashed.length} crashed agent(s).`);
  }

  // 2. Start DriftMonitor
  const driftMonitor = new DriftMonitor({
    thresholds: config.drift.thresholds,
    onDriftEvent: handleDriftEvent,
  });
  driftMonitor.start();

  // 3. Start approval console (+ optional UI server)
  const uiEnabled = config.ui?.enabled === true;

  const handleApprovalDecided: import("./io/approvalConsole.js").ApprovalDecidedCallback =
    async (approvalId, type, decision, project, relatedTaskRefs) => {
      void approvalId;
      if (type === "project_assignment" && decision === "approved" && project !== null) {
        await activateProject(project);
      }
      if (type === "plan_approval" && project !== null) {
        if (decision === "approved") {
          await activateKickoffTasks(project, relatedTaskRefs);
          await setProjectStatus(project, "active");
        } else if (decision === "declined") {
          await cancelKickoffTasks(project, relatedTaskRefs);
          await setProjectStatus(project, "kickoff_pending");
        }
      }
    };

  const approvalConsole = new ApprovalConsole(handleApprovalDecided, uiEnabled);
  console.log("[Orchestrator] Approval console watching state/approvals/");

  if (uiEnabled) {
    const { startUIServer } = await import("./ui/server.js");
    await startUIServer({ port: config.ui?.port ?? 4242, onApprovalDecided: handleApprovalDecided });
  }

  // 4. Watch task files for sentinel signals and agent log lines
  const taskWatcher = Watcher.create(
    ["state/tasks/**/*.md"],
    async (event, filePath) => {
      if (event !== "change" && event !== "add") return;

      try {
        void emitAgentLogLines(filePath);

        const newStatus = await applyPendingTransition(filePath);
        if (newStatus !== null) {
          console.log(`[Pipeline] ${filePath}: → ${newStatus}`);
          await handleTransition(filePath, newStatus, config, rolesConfig, spawnDeps);
        }
      } catch (err: unknown) {
        console.error(`[Orchestrator] Error processing ${filePath}:`, err);
      }
    },
  );

  // 5. Scheduler poll
  const schedulerInterval = setInterval(() => {
    void runSchedulerCycle({
      ...spawnDeps,
      onAgentResult: (result) => {
        if (!result.success) {
          console.error(`[Scheduler] Agent ${result.agent_id} failed:`, result.error);
        }
      },
    });
  }, config.orchestrator.poll_interval_ms);

  // 6. Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("[Orchestrator] Shutting down...");
    clearInterval(schedulerInterval);
    await taskWatcher.close();
    await approvalConsole.close();
    await driftMonitor.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  console.log("[Orchestrator] Running. Press Ctrl+C to stop.");
}

main().catch((err: unknown) => {
  console.error("[Orchestrator] Fatal error:", err);
  process.exit(1);
});
