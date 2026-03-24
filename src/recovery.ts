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
import { scrubSentinels } from "./workflow/taskPipeline.js";
import type { LiveAgentRegistry, TaskFrontmatter, TaskStatus, AgentRole } from "./types/index.js";

const REGISTRY_PATH = "state/agents/live.json";

function isProcessRunning(pid: number): boolean {
  if (pid <= 0) return false; // invalid PID — treat as dead
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
      await markTaskBlocked(identity.task_id, agentId, identity.role);
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
  role: AgentRole,
): Promise<void> {
  const doc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
  if (doc === null) return;

  const currentStatus = doc.frontmatter.status;
  let targetStatus: TaskStatus;
  const updates: Partial<TaskFrontmatter> = {};

  // Determine the correct revert status and which assignment field to clear
  // based on the task's current status — role alone is insufficient for
  // distinguishing e.g. steward_review from steward_final.
  if (currentStatus === "in_progress" || currentStatus === "assigned") {
    targetStatus = "pending";
    updates.assigned_crafter = null;
  } else if (currentStatus === "steward_review" || currentStatus === "steward_final") {
    targetStatus = currentStatus; // keep status; recoverOrphanedReviewTasks respawns
    updates.assigned_steward = null;
  } else if (currentStatus === "council_review" || currentStatus === "compound") {
    targetStatus = currentStatus;
    updates.assigned_council_author = null;
  } else if (currentStatus === "council_peer_review") {
    targetStatus = currentStatus;
    updates.assigned_council_peer = null;
  } else {
    targetStatus = "blocked";
  }

  const updated: TaskFrontmatter = {
    ...doc.frontmatter,
    ...updates,
    status: targetStatus,
    updated_at: new Date().toISOString(),
  };

  const isCrafter = role === "crafter";
  const appendedBody =
    scrubSentinels(doc.body) +
    `\n\n## Recovery Note\n\nTask reset after crash of agent \`${crashedAgentId}\` (role: ${role}). ` +
    (isCrafter ? "Scheduler will reassign." : "Agent will be respawned by recovery.") + "\n";

  await writeMarkdownFile(taskFilePath, updated, appendedBody);
}

async function notifyCrashRecovery(crashedAgentIds: string[]): Promise<void> {
  // Write directly to Tarantoga's inbox — task_cancellation approvals are
  // auto-approved and would be silently dismissed, hiding crash events.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const notifPath = `state/inbox/tarantoga/unread/crash-recovery-${timestamp}.md`;
  await writeFile(
    notifPath,
    [
      "## Crash Recovery Report",
      "",
      `${crashedAgentIds.length} agent(s) were found crashed on orchestrator startup.`,
      "",
      "**Crashed agents:**",
      ...crashedAgentIds.map((id) => `- \`${id}\``),
      "",
      "Their tasks have been reset. Crafters → pending (scheduler will reassign). " +
        "Other roles → same review status (agent will be respawned by recovery).",
      "",
      `**Detected at:** ${new Date().toISOString()}`,
    ].join("\n"),
  );
}
