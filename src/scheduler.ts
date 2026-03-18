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
import { spawnCouncilForKickoff } from "./agents/council.js";
import { evaluateTransitions } from "./workflow/taskPipeline.js";
import { listProjects, setProjectStatus } from "./workflow/onboarding.js";
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
 * Reset an orphaned task (assigned but no live agent) back to pending.
 */
async function resetOrphanedTask(filePath: string): Promise<void> {
  const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
  if (doc === null) return;
  const updated: TaskFrontmatter = {
    ...doc.frontmatter,
    status: "pending",
    assigned_crafter: null,
    updated_at: new Date().toISOString(),
  };
  await writeMarkdownFile(filePath, updated, doc.body);
  console.warn(`[Scheduler] Orphaned task reset to pending: ${filePath}`);
}

/**
 * Run one scheduling cycle: assign pending tasks to new agents.
 * Called by the orchestrator on its poll interval.
 */
export async function runSchedulerCycle(
  deps: SchedulerDependencies,
): Promise<void> {
  // Detect and launch kickoff agents for newly activated projects
  const kickoffProjects = await listProjects("kickoff_pending");
  for (const project of kickoffProjects) {
    await setProjectStatus(project.slug, "kickoff_in_progress");
    const councilId = `council-kickoff-${randomUUID()}`;
    await spawnCouncilForKickoff(
      project.slug,
      project.path,
      councilId,
      deps,
      async (result) => {
        if (!result.success) {
          console.error(`[Scheduler] Kickoff Council failed for ${project.slug} — requeueing`);
          await setProjectStatus(project.slug, "kickoff_pending");
        }
      },
    );
  }

  const pending = await scanPendingTasks();
  if (pending.length === 0) return;

  const registry = await readRegistry();
  const activeAgentCount = Object.keys(registry).length;

  // Simple capacity check — prevent spawning too many agents at once
  const MAX_CONCURRENT_AGENTS = 8;
  if (activeAgentCount >= MAX_CONCURRENT_AGENTS) return;

  for (const task of pending) {
    if (task.frontmatter.status === "assigned") {
      const alive =
        task.frontmatter.assigned_crafter !== null &&
        registry[task.frontmatter.assigned_crafter] !== undefined;
      if (alive) continue;

      // Re-read body and check for a pending sentinel before resetting.
      // If a sentinel is present, the file watcher will apply the transition —
      // do not stomp it with an orphan reset.
      const freshDoc = await readMarkdownFile<TaskFrontmatter>(task.filePath);
      if (freshDoc !== null) {
        const pending = evaluateTransitions(
          freshDoc.frontmatter.status,
          freshDoc.body,
          freshDoc.frontmatter,
        );
        if (pending !== null) {
          console.log(`[Scheduler] Sentinel present in assigned task — skipping orphan reset: ${task.filePath}`);
          continue;
        }
      }

      await resetOrphanedTask(task.filePath);
      continue;
    }

    if (task.frontmatter.status !== "pending") continue;
    if (task.frontmatter.blocked_by.length > 0) {
      const resolved = await dependenciesResolved(task);
      if (!resolved) continue;
    }

    const crafterAgentId = `crafter-${randomUUID()}`;
    const projectPath = task.frontmatter.project_path ?? process.cwd();

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
