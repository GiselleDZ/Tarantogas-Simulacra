/**
 * Task activation and cancellation helpers for the Council kickoff flow.
 *
 * After Tarantoga approves or declines a plan_approval, the orchestrator
 * calls these helpers to bulk-update the status of all tasks that were
 * created by the Council during kickoff (status: "blocked").
 */
import path from "path";
import { promises as fs } from "fs";
import { readMarkdownFile, writeMarkdownFile } from "../io/fileStore.js";
import type { TaskFrontmatter } from "../types/index.js";

const TASKS_DIR = "state/tasks";

/** Locate the file path for a task by its ID within a project's task directory. */
async function findTaskFilePath(
  projectSlug: string,
  taskId: string,
): Promise<string | null> {
  const projectTasksPath = path.join(TASKS_DIR, projectSlug);
  let entries: string[];
  try {
    entries = await fs.readdir(projectTasksPath);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(projectTasksPath, entry);
    const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
    if (doc?.frontmatter.id === taskId) {
      return filePath;
    }
  }
  return null;
}

/**
 * Activate blocked kickoff tasks by setting their status to "pending".
 * Called when Tarantoga approves the plan_approval.
 */
export async function activateKickoffTasks(
  projectSlug: string,
  taskIds: readonly string[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const taskId of taskIds) {
    const filePath = await findTaskFilePath(projectSlug, taskId);
    if (filePath === null) {
      console.warn(`[TaskCreation] Task not found: ${taskId} in project ${projectSlug}`);
      continue;
    }
    const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
    if (doc === null) continue;
    await writeMarkdownFile(
      filePath,
      { ...doc.frontmatter, status: "pending", updated_at: now },
      doc.body,
    );
    console.log(`[TaskCreation] Activated task ${taskId} → pending`);
  }
}

/**
 * Cancel blocked kickoff tasks by setting their status to "cancelled".
 * Called when Tarantoga declines the plan_approval.
 */
export async function cancelKickoffTasks(
  projectSlug: string,
  taskIds: readonly string[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const taskId of taskIds) {
    const filePath = await findTaskFilePath(projectSlug, taskId);
    if (filePath === null) {
      console.warn(`[TaskCreation] Task not found: ${taskId} in project ${projectSlug}`);
      continue;
    }
    const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
    if (doc === null) continue;
    await writeMarkdownFile(
      filePath,
      { ...doc.frontmatter, status: "cancelled", updated_at: now },
      doc.body,
    );
    console.log(`[TaskCreation] Cancelled task ${taskId}`);
  }
}
