/**
 * Crafter agent coordination helpers.
 *
 * Crafters run as Claude Code subprocesses scoped to their project filesystem.
 * This module provides orchestrator helpers for spawning Crafters.
 */
import { spawnAgent } from "./spawner.js";
import type { AgentContext, AgentResult } from "../types/index.js";

interface SpawnDependencies {
  readonly rolesConfig: Parameters<typeof spawnAgent>[1]["rolesConfig"];
  readonly simulacraConfig: Parameters<typeof spawnAgent>[1]["simulacraConfig"];
}

/**
 * Spawn a Crafter to work on an assigned task.
 * The Crafter's filesystem is sandboxed to the project root.
 */
export async function spawnCrafter(
  taskFilePath: string,
  projectSlug: string,
  projectPath: string,
  crafterType: string,
  crafterAgentId: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => void | Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "crafter",
    agent_id: crafterAgentId,
    task_file_path: taskFilePath,
    project_path: projectPath,
    project_slug: projectSlug,
    phase: "work",
    extra_context: crafterType,
  };

  await spawnAgent(context, { ...deps, onExit });
}

/**
 * Spawn a Crafter to address Steward revision requests.
 * Reuses the same agent ID for continuity in drift monitoring.
 */
export async function spawnCrafterForRevision(
  taskFilePath: string,
  projectSlug: string,
  projectPath: string,
  crafterType: string,
  crafterAgentId: string,
  revisionContext: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => void | Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "crafter",
    agent_id: crafterAgentId,
    task_file_path: taskFilePath,
    project_path: projectPath,
    project_slug: projectSlug,
    phase: "revision",
    extra_context: `${crafterType}\n\n${revisionContext}`,
  };

  await spawnAgent(context, { ...deps, onExit });
}
