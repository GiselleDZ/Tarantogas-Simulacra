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
import { applyPendingTransition, scrubSentinels } from "./workflow/taskPipeline.js";
import { DriftMonitor } from "./services/driftMonitor.js";
import { recoverCrashedAgents } from "./recovery.js";
import { readRegistry } from "./agents/spawner.js";
import { runSchedulerCycle, MAX_CONCURRENT_AGENTS } from "./scheduler.js";
import {
  spawnCouncilForCompound,
  spawnCouncilForReview,
  spawnCouncilForPeerReview,
  spawnCouncilForResearchReview,
} from "./agents/council.js";
import { spawnCrafterForRevision } from "./agents/crafter.js";
import { spawnStewardForReview, spawnStewardForFinalSignOff } from "./agents/steward.js";
import { spawnResearchAgentForTask } from "./agents/researchAgent.js";
import { writeDriftLearning } from "./learning/councilLearning.js";
import { McpProxyServer } from "./services/mcpProxy.js";
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
  readonly orchestrator: {
    readonly poll_interval_ms: number;
    readonly agent_timeout_ms?: number;
  };
  readonly agents?: {
    readonly max_per_project?: number;
    readonly heartbeat_timeout_ms?: number;
  };
  readonly mcp_proxy?: {
    readonly enabled: boolean;
    readonly port?: number;
    readonly allowlist?: readonly string[];
  };
  readonly budget?: {
    readonly per_project_usd?: number;
    readonly global_usd?: number;
  };
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
 * Reset a task after an agent failure.
 * The revert status and cleared field are determined from the task's current
 * frontmatter status — the crashed agent's role alone is insufficient (e.g.
 * a steward can be in steward_review or steward_final).
 */
async function resetTaskToBlocked(filePath: string, agentId: string): Promise<void> {
  const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
  if (doc === null) {
    console.error(`[Orchestrator] resetTaskToBlocked: could not read ${filePath}`);
    return;
  }

  const currentStatus = doc.frontmatter.status;
  let targetStatus: TaskStatus = "blocked";
  const updates: Partial<TaskFrontmatter> = {};

  if (currentStatus === "in_progress" || currentStatus === "assigned") {
    targetStatus = "pending";
    updates.assigned_crafter = null;
  } else if (currentStatus === "steward_review" || currentStatus === "steward_final") {
    targetStatus = currentStatus; // recoverOrphanedReviewTasks will respawn
    updates.assigned_steward = null;
  } else if (currentStatus === "council_review" || currentStatus === "compound") {
    targetStatus = currentStatus;
    updates.assigned_council_author = null;
  } else if (currentStatus === "council_peer_review") {
    targetStatus = currentStatus;
    updates.assigned_council_peer = null;
  }

  const updated: TaskFrontmatter = {
    ...doc.frontmatter,
    ...updates,
    status: targetStatus,
    updated_at: new Date().toISOString(),
  };
  await writeMarkdownFile(filePath, updated, scrubSentinels(doc.body));
  console.warn(`[Orchestrator] Task ${filePath} reset to ${targetStatus} after agent ${agentId} failure.`);
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

// ── Review Orphan Recovery (Startup) ─────────────────────────────────────────

const REVIEW_RECOVERY_STATUSES: readonly TaskStatus[] = [
  "steward_review", "steward_final",
  "council_review", "council_peer_review",
];

function getAssignedReviewAgent(fm: TaskFrontmatter): string | null {
  if (fm.status === "steward_review" || fm.status === "steward_final") return fm.assigned_steward;
  if (fm.status === "council_peer_review") return fm.assigned_council_peer;
  return fm.assigned_council_author; // council_review
}

async function getAllTaskFilePaths(): Promise<string[]> {
  const paths: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir("state/tasks");
  } catch {
    return [];
  }
  for (const projectDir of projectDirs) {
    const projectTasksPath = path.join("state/tasks", projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(projectTasksPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      paths.push(path.join(projectTasksPath, entry));
    }
  }
  return paths;
}

async function recoverOrphanedReviewTasks(
  config: OrchestratorConfig,
  rolesConfig: RolesConfig,
  spawnDeps: { rolesConfig: RolesConfig; simulacraConfig: OrchestratorConfig },
): Promise<void> {
  const registry = await readRegistry();
  const taskFiles = await getAllTaskFilePaths();
  let spawned = 0;

  for (const filePath of taskFiles) {
    if (spawned >= MAX_CONCURRENT_AGENTS) break;

    const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
    if (doc === null) continue;
    const { frontmatter } = doc;

    if (!REVIEW_RECOVERY_STATUSES.includes(frontmatter.status)) continue;

    const assignedAgent = getAssignedReviewAgent(frontmatter);
    if (assignedAgent !== null && registry[assignedAgent] !== undefined) continue; // alive

    console.log(`[Recovery] Respawning ${frontmatter.status} agent for ${frontmatter.id}`);
    await handleTransition(filePath, frontmatter.status, config, rolesConfig, spawnDeps);
    spawned++;
  }

  if (spawned > 0) {
    console.log(`[Recovery] Startup review recovery: ${spawned} agent(s) respawned`);
  }
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
      const councilId = frontmatter.assigned_council_author ?? `council-${randomUUID()}`;
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
      const stewardId = frontmatter.assigned_steward ?? `steward-${randomUUID()}`;
      // Write assigned_steward to frontmatter so steward_final → compound can validate it
      const stewardDoc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
      if (stewardDoc === null) {
        console.error(`[Orchestrator] steward_review: could not read ${taskFilePath} — aborting spawn`);
        break;
      }
      await writeMarkdownFile(taskFilePath, {
        ...stewardDoc.frontmatter,
        assigned_steward: stewardId,
        updated_at: new Date().toISOString(),
      }, stewardDoc.body);
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
      const stewardId = frontmatter.assigned_steward ?? `steward-${randomUUID()}`;
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
      // Write assigned_council_author to frontmatter so compound → council_review can validate it
      const compoundDoc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
      if (compoundDoc === null) {
        console.error(`[Orchestrator] compound: could not read ${taskFilePath} — aborting spawn`);
        break;
      }
      await writeMarkdownFile(taskFilePath, {
        ...compoundDoc.frontmatter,
        assigned_council_author: councilId,
        updated_at: new Date().toISOString(),
      }, compoundDoc.body);
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
      // Ensure assigned_council_author is persisted for council_review → council_peer_review
      const reviewDoc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
      if (reviewDoc === null) {
        console.error(`[Orchestrator] council_review: could not read ${taskFilePath} — aborting spawn`);
        break;
      }
      await writeMarkdownFile(taskFilePath, {
        ...reviewDoc.frontmatter,
        assigned_council_author: authorId,
        updated_at: new Date().toISOString(),
      }, reviewDoc.body);
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
      // Write assigned_council_peer to frontmatter so council_peer_review → done can validate it
      const peerDoc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
      if (peerDoc === null) {
        console.error(`[Orchestrator] council_peer_review: could not read ${taskFilePath} — aborting spawn`);
        break;
      }
      await writeMarkdownFile(taskFilePath, {
        ...peerDoc.frontmatter,
        assigned_council_peer: peerId,
        updated_at: new Date().toISOString(),
      }, peerDoc.body);
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

    case "crafter_revision": {
      const crafterId = frontmatter.assigned_crafter ?? `crafter-${randomUUID()}`;
      const revisionContext =
        "Review the steward and council review sections of your task file for revision requests.";
      await spawnCrafterForRevision(
        taskFilePath,
        frontmatter.project,
        projectPath,
        frontmatter.crafter_type,
        crafterId,
        revisionContext,
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
      // Other transitions (in_progress, etc.) need no orchestrator action
      // beyond the frontmatter update already applied.
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

/**
 * Serializes watcher callbacks per file path.
 * Chokidar can deliver multiple events for the same file within the
 * awaitWriteFinish window. Without serialization, two concurrent callbacks
 * can both enter handleTransition and spawn duplicate agents.
 */
const watcherCallbackChains = new Map<string, Promise<void>>();

function sectionToLogRole(section: string): AgentLogRole {
  const s = section.toLowerCase();
  if (s.includes("crafter")) return "crafter";
  if (s.includes("steward")) return "steward";
  if (s.includes("council")) return "council";
  if (s.includes("research")) return "research";
  return "council";
}

function getAgentIdForLogSection(section: string, frontmatter: TaskFrontmatter): string {
  const s = section.toLowerCase();
  if (s.includes("crafter")) return frontmatter.assigned_crafter ?? "completed";
  if (s.includes("steward")) return frontmatter.assigned_steward ?? "completed";
  if (s.includes("council peer")) return frontmatter.assigned_council_peer ?? "completed";
  if (s.includes("council")) return frontmatter.assigned_council_author ?? "completed";
  if (s.includes("research")) return "research";
  return frontmatter.assigned_council_author ?? "completed";
}

async function emitAgentLogLines(filePath: string): Promise<void> {
  const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
  if (doc === null) return;

  const previousOffset = emittedBodyOffsets.get(filePath) ?? 0;
  const newContent = doc.body.slice(previousOffset);
  const lines = parseAgentLogLines(newContent);

  for (const line of lines) {
    const role = sectionToLogRole(line.section);
    const agentId = getAgentIdForLogSection(line.section, doc.frontmatter);
    printAgentLogLine(role, agentId, doc.frontmatter.id, line);
  }

  emittedBodyOffsets.set(filePath, doc.body.length);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Prepend HH:MM:SS to every console line for the lifetime of this process
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const ts = (): string => {
    const now = new Date();
    const mon = MONTHS[now.getMonth()];
    const dd = String(now.getDate()).padStart(2, "0");
    const yyyy = now.getFullYear();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    return `\x1b[90m${mon} ${dd}, ${yyyy} ${hh}:${mm}\x1b[0m`;
  };
  console.log = (...args: unknown[]) => { origLog(ts(), ...args); };
  console.warn = (...args: unknown[]) => { origWarn(ts(), ...args); };
  console.error = (...args: unknown[]) => { origError(ts(), ...args); };

  console.log("[Orchestrator] Starting Simulacra...");

  const config = await loadConfig();
  const rolesConfig = await loadRolesConfig();

  // 1. Start MCP egress proxy (optional) — must be ready before crash recovery
  //    respawns agents that need proxy routing.
  let mcpProxy: McpProxyServer | null = null;
  if (config.mcp_proxy?.enabled === true) {
    mcpProxy = new McpProxyServer({
      port: config.mcp_proxy.port ?? 8899,
      allowlist: config.mcp_proxy.allowlist ?? [],
    });
    await mcpProxy.start();
  }

  const spawnDeps = {
    rolesConfig,
    simulacraConfig: config,
    ...(mcpProxy !== null ? { proxyToken: mcpProxy.token } : {}),
  };

  // 2. Crash recovery
  const crashed = await recoverCrashedAgents();
  if (crashed.length > 0) {
    console.warn(`[Orchestrator] Recovered ${crashed.length} crashed agent(s).`);
  }
  await recoverOrphanedReviewTasks(config, rolesConfig, spawnDeps);

  // 3. Start DriftMonitor
  const driftMonitor = new DriftMonitor({
    thresholds: config.drift.thresholds,
    onDriftEvent: handleDriftEvent,
  });
  driftMonitor.start();

  // 4. Start approval console (+ optional UI server)
  const uiEnabled = config.ui?.enabled === true;

  const handleApprovalDecided: import("./io/approvalConsole.js").ApprovalDecidedCallback =
    async (_approvalId, type, decision, project, relatedTaskRefs) => {
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

  // 5. Watch task files for sentinel signals and agent log lines
  const taskWatcher = Watcher.create(
    ["state/tasks/**/*.md"],
    (event, filePath) => {
      if (event === "unlink") {
        // Clean up chains and offsets for deleted files
        watcherCallbackChains.delete(filePath);
        emittedBodyOffsets.delete(filePath);
        return;
      }
      if (event !== "change" && event !== "add") return;

      // Serialize callbacks per file — prevents concurrent handleTransition for the same task.
      const prev = watcherCallbackChains.get(filePath) ?? Promise.resolve();
      const next = prev.then(async () => {
        try {
          void emitAgentLogLines(filePath);

          // Task file size monitoring: warn when a task file grows large.
          // Section archival (in taskPipeline) handles files that exceed the per-section
          // threshold, but this catches cases where the file grows before a transition fires.
          const TASK_SIZE_WARN_BYTES = 50_000; // 50 KB
          try {
            const { size } = await fs.stat(filePath);
            if (size > TASK_SIZE_WARN_BYTES) {
              console.warn(
                `[Orchestrator] Task file ${filePath} is ${Math.round(size / 1024)}KB — ` +
                `may approach context limit. Archival will trigger on next transition.`,
              );
            }
          } catch { /* file may not exist yet */ }

          const newStatus = await applyPendingTransition(filePath);
          if (newStatus !== null) {
            console.log(`[Pipeline] ${filePath}: → ${newStatus}`);
            await handleTransition(filePath, newStatus, config, rolesConfig, spawnDeps);
            if (newStatus === "done" || newStatus === "cancelled") {
              watcherCallbackChains.delete(filePath);
            }
          }
        } catch (err: unknown) {
          console.error(`[Orchestrator] Error processing ${filePath}:`, err);
        }
      });
      watcherCallbackChains.set(filePath, next);
    },
  );

  // 6. Scheduler poll
  // Guard prevents overlapping cycles if a cycle takes longer than the poll interval.
  let schedulerCycleInFlight = false;
  const schedulerInterval = setInterval(() => {
    if (schedulerCycleInFlight) return;
    schedulerCycleInFlight = true;
    void runSchedulerCycle({
      ...spawnDeps,
      onAgentResult: (result) => {
        if (!result.success) {
          console.error(`[Scheduler] Agent ${result.agent_id} failed:`, result.error);
        }
      },
      onOrphanedReviewTask: async (filePath, status) => {
        await handleTransition(filePath, status, config, rolesConfig, spawnDeps);
      },
      ...(config.agents?.max_per_project !== undefined ? { maxAgentsPerProject: config.agents.max_per_project } : {}),
      ...(config.agents?.heartbeat_timeout_ms !== undefined ? { heartbeatTimeoutMs: config.agents.heartbeat_timeout_ms } : {}),
      ...(config.budget !== undefined ? { budget: config.budget } : {}),
    })
      .catch((err: unknown) => { console.error("[Scheduler] Cycle error:", err); })
      .finally(() => { schedulerCycleInFlight = false; });
  }, config.orchestrator.poll_interval_ms);

  // 7. Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("[Orchestrator] Shutting down...");
    clearInterval(schedulerInterval);
    await taskWatcher.close();
    await approvalConsole.close();
    await driftMonitor.stop();
    if (mcpProxy !== null) await mcpProxy.stop();
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
