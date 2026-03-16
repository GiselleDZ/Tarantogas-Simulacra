/**
 * Steward agent coordination helpers.
 *
 * Stewards run as Claude Code subprocesses. This module provides orchestrator
 * helpers for spawning Steward agents at the right pipeline stages.
 */
import { spawnAgent } from "./spawner.js";
import type { AgentContext, AgentResult } from "../types/index.js";

interface SpawnDependencies {
  readonly rolesConfig: Parameters<typeof spawnAgent>[1]["rolesConfig"];
  readonly simulacraConfig: Parameters<typeof spawnAgent>[1]["simulacraConfig"];
}

/**
 * Spawn a Steward for the initial review stage (steward_review).
 */
export async function spawnStewardForReview(
  taskFilePath: string,
  projectSlug: string,
  projectPath: string,
  stewardAgentId: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => void | Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "steward",
    agent_id: stewardAgentId,
    task_file_path: taskFilePath,
    project_path: projectPath,
    project_slug: projectSlug,
    extra_context: `You are reviewing this task for the first time. Review the Crafter's work against the acceptance criteria. Write your findings in the Steward Review section. If revisions are needed, signal: STATUS_SIGNAL: crafter_revision_requested. If approved, signal: STATUS_SIGNAL: ready_for_steward_final`,
  };

  await spawnAgent(context, { ...deps, onExit });
}

/**
 * Spawn a Steward for the final sign-off stage (steward_final).
 * Includes Tier 2 drift assessment.
 */
export async function spawnStewardForFinalSignOff(
  taskFilePath: string,
  projectSlug: string,
  projectPath: string,
  crafterAgentId: string,
  stewardAgentId: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => void | Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "steward",
    agent_id: stewardAgentId,
    task_file_path: taskFilePath,
    project_path: projectPath,
    project_slug: projectSlug,
    extra_context: `You are giving final sign-off on this task. The Crafter has addressed your revision requests. First, read the DriftMonitor report for Crafter ${crafterAgentId} in state/drift/reports/. Conduct your Tier 2 drift assessment. If drift is confirmed, write DRIFT_SIGNAL: FLAGGED in your Steward Final section. If drift is cleared, write DRIFT_SIGNAL: CLEARED. Then, if work quality is acceptable, signal: STATUS_SIGNAL: ready_for_compound`,
  };

  await spawnAgent(context, { ...deps, onExit });
}
