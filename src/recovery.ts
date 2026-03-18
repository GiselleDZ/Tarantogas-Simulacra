/**
 * Crash recovery module.
 *
 * On orchestrator startup, reads the live agent registry and reconciles
 * it against actual running processes. Any agent in the registry that is
 * no longer running is considered crashed — its task is marked blocked
 * and a notification is sent to Tarantoga's inbox.
 */
import { readFile, writeFile } from "./io/fileStore.js";
import { readMarkdownFile, writeMarkdownFile } from "./io/fileStore.js";
import { createApproval } from "./workflow/approvalQueue.js";
import type { LiveAgentRegistry, TaskFrontmatter } from "./types/index.js";

const REGISTRY_PATH = "state/agents/live.json";

function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 checks if the process exists without sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run crash recovery on orchestrator startup.
 * Returns the list of agent IDs that were found crashed and recovered.
 */
export async function recoverCrashedAgents(): Promise<string[]> {
  const raw = await readFile(REGISTRY_PATH);
  if (raw === null) return [];

  const registry = JSON.parse(raw) as LiveAgentRegistry;
  const crashed: string[] = [];

  for (const [agentId, identity] of Object.entries(registry)) {
    if (isProcessRunning(identity.pid)) continue;

    crashed.push(agentId);
    console.warn(`[Recovery] Crashed agent detected: ${agentId} (pid ${identity.pid})`);

    // If the agent was working on a task, mark it blocked
    if (identity.task_id !== undefined) {
      await markTaskBlocked(identity.task_id, agentId);
    }
  }

  if (crashed.length > 0) {
    // Rebuild registry with only living agents
    const surviving: LiveAgentRegistry = {};
    for (const [id, identity] of Object.entries(registry)) {
      if (!crashed.includes(id)) {
        surviving[id] = identity;
      }
    }
    await writeFile(REGISTRY_PATH, JSON.stringify(surviving, null, 2));

    await notifyCrashRecovery(crashed);
  }

  return crashed;
}

async function markTaskBlocked(
  taskFilePath: string,
  crashedAgentId: string,
): Promise<void> {
  const doc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
  if (doc === null) return;

  const updated: TaskFrontmatter = {
    ...doc.frontmatter,
    status: "pending",
    assigned_crafter: null,
    updated_at: new Date().toISOString(),
  };

  const appendedBody =
    doc.body +
    `\n\n## Recovery Note\n\nTask re-queued after crash of agent \`${crashedAgentId}\`. Scheduler will reassign.\n`;

  await writeMarkdownFile(
    taskFilePath,
    updated,
    appendedBody,
  );
}

async function notifyCrashRecovery(crashedAgentIds: string[]): Promise<void> {
  const body = [
    "## Crash Recovery Report",
    "",
    `${crashedAgentIds.length} agent(s) were found crashed on orchestrator startup.`,
    "",
    "**Crashed agents:**",
    ...crashedAgentIds.map((id) => `- \`${id}\``),
    "",
    "Their tasks have been marked `blocked`. Review and reassign as needed.",
  ].join("\n");

  await createApproval({
    type: "task_cancellation",
    createdBy: "orchestrator",
    project: null,
    councilRecommendation: "needs_research",
    relatedTaskRefs: [],
    body,
    urgent: true,
  });
}
