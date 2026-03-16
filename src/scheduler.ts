/**
 * Task scheduler — assigns pending tasks to available agents.
 *
 * The scheduler is called by the orchestrator on a regular interval.
 * It scans for pending tasks and spawns agents to work on them,
 * respecting task dependencies and priority ordering.
 */
import path from "path";
import { promises as fs } from "fs";
import { readMarkdownFile, writeMarkdownFile } from "./io/fileStore.js";
import { readRegistry } from "./agents/spawner.js";
import { spawnCrafter } from "./agents/crafter.js";
import { spawnStewardForReview } from "./agents/steward.js";
import { randomUUID } from "crypto";
import type {
  TaskFrontmatter,
  TaskStatus,
  AgentRole,
} from "./types/index.js";

const TASKS_DIR = "state/tasks";

interface SchedulerDependencies {
  readonly rolesConfig: Parameters<typeof spawnCrafter>[5]["rolesConfig"];
  readonly simulacraConfig: Parameters<typeof spawnCrafter>[5]["simulacraConfig"];
  readonly onAgentResult: Parameters<typeof spawnCrafter>[6];
}

interface PendingTask {
  readonly filePath: string;
  readonly frontmatter: TaskFrontmatter;
}

/**
 * Scan all project task directories for tasks that are ready to be assigned.
 * Returns tasks sorted by priority (critical → high → medium → low).
 */
async function scanPendingTasks(): Promise<PendingTask[]> {
  const tasks: PendingTask[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(TASKS_DIR);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const projectTasksPath = path.join(TASKS_DIR, projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(projectTasksPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(projectTasksPath, entry);
      const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
      if (doc === null) continue;

      const { frontmatter } = doc;
      if (
        frontmatter.status === "pending" ||
        frontmatter.status === "assigned"
      ) {
        tasks.push({ filePath, frontmatter });
      }
    }
  }

  return tasks.sort(comparePriority);
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function comparePriority(a: PendingTask, b: PendingTask): number {
  const pa = PRIORITY_ORDER[a.frontmatter.priority] ?? 2;
  const pb = PRIORITY_ORDER[b.frontmatter.priority] ?? 2;
  return pa - pb;
}

/**
 * Check whether all tasks listed in blocked_by are done.
 */
async function dependenciesResolved(
  task: PendingTask,
): Promise<boolean> {
  for (const depId of task.frontmatter.blocked_by) {
    // Simple scan: look for the task file containing this ID in frontmatter
    // A more efficient implementation would maintain an index
    const depResolved = await isDoneById(depId);
    if (!depResolved) return false;
  }
  return true;
}

async function isDoneById(taskId: string): Promise<boolean> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(TASKS_DIR);
  } catch {
    return false;
  }

  for (const projectDir of projectDirs) {
    const projectTasksPath = path.join(TASKS_DIR, projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(projectTasksPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const doc = await readMarkdownFile<TaskFrontmatter>(
        path.join(projectTasksPath, entry),
      );
      if (doc?.frontmatter.id === taskId) {
        return doc.frontmatter.status === "done";
      }
    }
  }

  return false;
}

/**
 * Run one scheduling cycle: assign pending tasks to new agents.
 * Called by the orchestrator on its poll interval.
 */
export async function runSchedulerCycle(
  deps: SchedulerDependencies,
): Promise<void> {
  const pending = await scanPendingTasks();
  if (pending.length === 0) return;

  const registry = await readRegistry();
  const activeAgentCount = Object.keys(registry).length;

  // Simple capacity check — prevent spawning too many agents at once
  const MAX_CONCURRENT_AGENTS = 8;
  if (activeAgentCount >= MAX_CONCURRENT_AGENTS) return;

  for (const task of pending) {
    if (task.frontmatter.status !== "pending") continue;
    if (task.frontmatter.blocked_by.length > 0) {
      const resolved = await dependenciesResolved(task);
      if (!resolved) continue;
    }

    const crafterAgentId = `crafter-${randomUUID()}`;
    const projectPath = path.dirname(path.dirname(task.filePath));

    // Mark as assigned before spawning
    const updated: TaskFrontmatter = {
      ...task.frontmatter,
      status: "assigned",
      assigned_crafter: crafterAgentId,
      updated_at: new Date().toISOString(),
    };

    // We need the body to re-write — fetch it
    const doc = await readMarkdownFile<TaskFrontmatter>(task.filePath);
    if (doc === null) continue;

    await writeMarkdownFile(
      task.filePath,
      updated,
      doc.body,
    );

    await spawnCrafter(
      task.filePath,
      task.frontmatter.project,
      projectPath,
      task.frontmatter.crafter_type,
      crafterAgentId,
      deps,
      deps.onAgentResult,
    );

    break; // One spawn per cycle to avoid thundering herd
  }
}
