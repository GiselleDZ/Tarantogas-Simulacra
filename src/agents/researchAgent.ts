/**
 * Research agent coordination helpers.
 *
 * Research agents are spawned by Council when investigation is needed
 * before making a planning decision or approval recommendation.
 */
import { spawnAgent } from "./spawner.js";
import type { AgentContext, AgentResult } from "../types/index.js";

interface SpawnDependencies {
  readonly rolesConfig: Parameters<typeof spawnAgent>[1]["rolesConfig"];
  readonly simulacraConfig: Parameters<typeof spawnAgent>[1]["simulacraConfig"];
}

export interface ResearchRequest {
  readonly question: string;
  readonly outputPath: string;
  readonly projectSlug: string | null;
  readonly requestedBy: string;
}

/**
 * Spawn a Research agent to answer a specific question.
 * The agent writes its structured report to outputPath.
 */
export async function spawnResearchAgent(
  request: ResearchRequest,
  agentId: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => void | Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "research",
    agent_id: agentId,
    ...(request.projectSlug !== null ? { project_slug: request.projectSlug } : {}),
    extra_context: [
      `Research Question: ${request.question}`,
      ``,
      `Write your structured research report to: ${request.outputPath}`,
      ``,
      `Use the format defined in your role CLAUDE.md (Summary / Evidence / Gaps / Recommendation).`,
      `Requested by: ${request.requestedBy}`,
    ].join("\n"),
  };

  await spawnAgent(context, { ...deps, onExit });
}
