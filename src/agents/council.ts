/**
 * Council agent coordination helpers.
 *
 * Council agents run as Claude Code subprocesses (via spawner.ts).
 * This module provides the orchestrator with helpers for:
 *   - Assigning Council members to tasks (author + peer reviewer)
 *   - Reading Council review decisions from task files
 *   - Coordinating the Compound step and peer-review assignment
 */
import path from "path";
import { readMarkdownFile, writeMarkdownFile } from "../io/fileStore.js";
import { spawnAgent } from "./spawner.js";
import type {
  TaskFrontmatter,
  AgentContext,
  AgentResult,
} from "../types/index.js";

interface SpawnDependencies {
  readonly rolesConfig: Parameters<typeof spawnAgent>[1]["rolesConfig"];
  readonly simulacraConfig: Parameters<typeof spawnAgent>[1]["simulacraConfig"];
}

/**
 * Spawn a Council agent to conduct the Compound step interview.
 * The agent is given the task file path and project context.
 */
export async function spawnCouncilForCompound(
  taskFilePath: string,
  projectSlug: string,
  projectPath: string,
  councilAgentId: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => void | Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "council",
    agent_id: councilAgentId,
    task_file_path: taskFilePath,
    project_path: projectPath,
    project_slug: projectSlug,
    phase: "compound",
    extra_context: `You are conducting the Compound step interview for this task. Read the task file, review the Crafter's work, and conduct a structured interview. Record the interview in state/drift/interviews/ and write your findings to the Compound Step section of the task file. When done, write: COMPOUND_SIGNAL: complete`,
  };

  await spawnAgent(context, { ...deps, onExit });
}

/**
 * Spawn a Council agent to author the Council review section.
 */
export async function spawnCouncilForReview(
  taskFilePath: string,
  projectSlug: string,
  projectPath: string,
  councilAgentId: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => void | Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "council",
    agent_id: councilAgentId,
    task_file_path: taskFilePath,
    project_path: projectPath,
    project_slug: projectSlug,
    phase: "council-review",
    extra_context: `You are the Council author reviewer for this task. Review the completed work, the Steward sign-off, and the Compound step record. Write your Council Review section and signal: COUNCIL_SIGNAL: APPROVED or COUNCIL_SIGNAL: REVISION_REQUIRED`,
  };

  await spawnAgent(context, { ...deps, onExit });
}

/**
 * Spawn a second Council agent for peer review.
 */
export async function spawnCouncilForPeerReview(
  taskFilePath: string,
  projectSlug: string,
  projectPath: string,
  peerAgentId: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => void | Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "council",
    agent_id: peerAgentId,
    task_file_path: taskFilePath,
    project_path: projectPath,
    project_slug: projectSlug,
    phase: "peer-review",
    extra_context: `You are the Council peer reviewer for this task. A peer Council member has already reviewed and approved. Independently review the work. Write your Council Peer Review section and signal: COUNCIL_SIGNAL: APPROVED or COUNCIL_SIGNAL: REVISION_REQUIRED`,
  };

  await spawnAgent(context, { ...deps, onExit });
}

/**
 * Spawn a Council agent to review research output and approve it for Crafter assignment.
 * The agent reads ## Research Output, writes ## Council Research Review, and signals approved.
 */
export async function spawnCouncilForResearchReview(
  taskFilePath: string,
  projectSlug: string,
  projectPath: string,
  councilAgentId: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => void | Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "council",
    agent_id: councilAgentId,
    task_file_path: taskFilePath,
    project_path: projectPath,
    project_slug: projectSlug,
    phase: "research-review",
    extra_context: `You are reviewing the research output for this task. Read the ## Research Output section, analyse the findings, and write your review and any recommendations to ## Council Research Review. Update the task frontmatter field research_doc_refs with paths to relevant research documents the Crafter should read. When satisfied, write: RESEARCH_SIGNAL: approved`,
  };

  await spawnAgent(context, { ...deps, onExit });
}

/**
 * Spawn a Council agent to perform a project kickoff.
 * No task file is provided — the agent reads the project's implementation plan,
 * assesses existing code, creates task files (status: blocked), and submits
 * a plan_approval for Tarantoga to review before work begins.
 */
export async function spawnCouncilForKickoff(
  projectSlug: string,
  projectPath: string,
  councilId: string,
  deps: SpawnDependencies,
  onExit: (result: AgentResult) => Promise<void>,
): Promise<void> {
  const context: AgentContext = {
    role: "council",
    agent_id: councilId,
    project_path: projectPath,
    project_slug: projectSlug,
    phase: "kickoff",
    extra_context: `You have no task file — your entry point is the ## Project Kickoff section of your CLAUDE.md role file.\nProject slug: ${projectSlug}\nProject path: ${projectPath}\nFollow the Project Kickoff workflow exactly as written in your role file.`,
  };

  await spawnAgent(context, { ...deps, onExit });
}

/**
 * Read assigned Council agent IDs from a task file.
 */
export async function readCouncilAssignments(
  taskFilePath: string,
): Promise<{ author: string | null; peer: string | null }> {
  const doc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
  if (doc === null) return { author: null, peer: null };
  return {
    author: doc.frontmatter.assigned_council_author,
    peer: doc.frontmatter.assigned_council_peer,
  };
}
