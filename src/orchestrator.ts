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
} from "./agents/council.js";
import { spawnStewardForReview, spawnStewardForFinalSignOff } from "./agents/steward.js";
import { writeDriftLearning } from "./learning/councilLearning.js";
import { randomUUID } from "crypto";
import type {
  TaskStatus,
  TaskFrontmatter,
  AgentResult,
  DriftEvent,
} from "./types/index.js";
import { readMarkdownFile } from "./io/fileStore.js";

// ── Configuration ─────────────────────────────────────────────────────────────

interface OrchestratorConfig {
  readonly orchestrator: { readonly poll_interval_ms: number };
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
  const projectPath = path.resolve(path.dirname(path.dirname(taskFilePath)));

  const onAgentExit = (result: AgentResult): void => {
    if (!result.success) {
      console.error(`[Orchestrator] Agent ${result.agent_id} exited with error: ${result.error ?? "unknown"}`);
    }
  };

  switch (newStatus) {
    case "steward_review": {
      const stewardId = `steward-${randomUUID()}`;
      await spawnStewardForReview(
        taskFilePath,
        frontmatter.project,
        projectPath,
        stewardId,
        spawnDeps,
        onAgentExit,
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
        onAgentExit,
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
        onAgentExit,
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
        onAgentExit,
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
        onAgentExit,
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

async function main(): Promise<void> {
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

  // 3. Watch task files for sentinel signals
  const taskWatcher = Watcher.create(
    ["state/tasks/**/*.md"],
    async (event, filePath) => {
      if (event !== "change" && event !== "add") return;

      try {
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

  // 4. Scheduler poll
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

  // 5. Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("[Orchestrator] Shutting down...");
    clearInterval(schedulerInterval);
    await taskWatcher.close();
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
