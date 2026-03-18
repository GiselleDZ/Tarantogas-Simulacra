/**
 * contextLoader — assembles research context for an approval:
 *   1. The body of the linked research approval (research_request_ref)
 *   2. The ## Research Output section from each related task file
 */
import path from "path";
import { promises as fs } from "fs";
import { readMarkdownFile } from "../io/fileStore.js";
import type { ApprovalFrontmatter, TaskFrontmatter } from "../types/index.js";

export interface ApprovalContext {
  readonly researchApprovalBody: string | null;
  readonly taskSections: ReadonlyArray<{ readonly taskId: string; readonly content: string }>;
}

function extractSection(body: string, heading: string): string | null {
  const marker = `## ${heading}`;
  const start = body.indexOf(marker);
  if (start === -1) return null;
  const contentStart = body.indexOf("\n", start) + 1;
  const nextHeading = body.indexOf("\n## ", contentStart);
  const raw = nextHeading === -1 ? body.slice(contentStart) : body.slice(contentStart, nextHeading);
  return raw.trim() || null;
}

async function findTaskFile(taskId: string): Promise<string | null> {
  let projects: string[];
  try {
    projects = await fs.readdir("state/tasks");
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = path.join("state/tasks", project, `${taskId}.md`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not in this project slug
    }
  }
  return null;
}

export async function loadContext(approvalId: string): Promise<ApprovalContext> {
  const filePath = path.join("state/approvals", `${approvalId}.md`);
  const doc = await readMarkdownFile<ApprovalFrontmatter>(filePath);
  if (doc === null) return { researchApprovalBody: null, taskSections: [] };

  let researchApprovalBody: string | null = null;
  if (doc.frontmatter.research_request_ref !== null) {
    const researchPath = path.join("state/approvals", `${doc.frontmatter.research_request_ref}.md`);
    const researchDoc = await readMarkdownFile<ApprovalFrontmatter>(researchPath);
    if (researchDoc !== null) {
      researchApprovalBody = researchDoc.body.trim() || null;
    }
  }

  const taskSections: Array<{ taskId: string; content: string }> = [];
  for (const taskId of doc.frontmatter.related_task_refs) {
    const taskFile = await findTaskFile(taskId);
    if (taskFile === null) continue;
    const taskDoc = await readMarkdownFile<TaskFrontmatter>(taskFile);
    if (taskDoc === null) continue;
    const section = extractSection(taskDoc.body, "Research Output");
    if (section !== null) taskSections.push({ taskId, content: section });
  }

  return { researchApprovalBody, taskSections };
}
