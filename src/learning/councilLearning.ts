import path from "path";
import { readFile, writeFile, appendLine } from "../io/fileStore.js";
import type { AgentRole } from "../types/index.js";

// ── Knowledge Base Paths ──────────────────────────────────────────────────────

const GLOBAL_KNOWLEDGE = "state/knowledge/global";
const PROJECT_KNOWLEDGE = "state/knowledge/projects";

// ── Learning Entry ────────────────────────────────────────────────────────────

export interface LearningEntry {
  readonly timestamp: string;
  readonly agent_id: string;
  readonly role: AgentRole;
  readonly task_id: string | null;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
}

export interface DriftLearning extends LearningEntry {
  readonly drift_score: number;
  readonly drift_cause: string;
  readonly prevention_notes: string;
}

// ── Write Learning ────────────────────────────────────────────────────────────

/**
 * Append a general learning entry to the project-specific knowledge base.
 * Used by Council during Compound step to record task-level learnings.
 */
export async function writeProjectLearning(
  projectSlug: string,
  crafterType: string,
  entry: LearningEntry,
): Promise<void> {
  const dir = path.join(PROJECT_KNOWLEDGE, projectSlug, crafterType);
  const filePath = path.join(dir, "compound-learnings.md");
  const block = formatLearningBlock(entry);
  await appendMarkdownSection(filePath, block);
}

/**
 * Write a drift learning to both project-specific and global knowledge bases.
 * Called after a pre-decommission interview.
 */
export async function writeDriftLearning(
  projectSlug: string | null,
  role: AgentRole,
  entry: DriftLearning,
): Promise<void> {
  const block = formatDriftBlock(entry);

  // Global knowledge base (anonymized, cross-project)
  const globalPath = path.join(GLOBAL_KNOWLEDGE, role, "drift-patterns.md");
  await appendMarkdownSection(globalPath, block);

  // Project-specific knowledge base (if applicable)
  if (projectSlug !== null) {
    const projectPath = path.join(
      PROJECT_KNOWLEDGE,
      projectSlug,
      role,
      "drift-learnings.md",
    );
    await appendMarkdownSection(projectPath, block);
  }
}

/**
 * Write a general learning to the global knowledge base for a role type.
 */
export async function writeGlobalLearning(
  role: AgentRole,
  section: string,
  entry: LearningEntry,
): Promise<void> {
  const filePath = path.join(GLOBAL_KNOWLEDGE, role, `${section}.md`);
  const block = formatLearningBlock(entry);
  await appendMarkdownSection(filePath, block);
}

// ── Read Learning ─────────────────────────────────────────────────────────────

/**
 * Read the full contents of a project-specific knowledge file.
 * Returns null if the file does not exist yet.
 */
export async function readProjectKnowledge(
  projectSlug: string,
  crafterType: string,
  section: string,
): Promise<string | null> {
  const filePath = path.join(
    PROJECT_KNOWLEDGE,
    projectSlug,
    crafterType,
    `${section}.md`,
  );
  return readFile(filePath);
}

/**
 * Read the full contents of a global knowledge file for a role type.
 */
export async function readGlobalKnowledge(
  role: AgentRole,
  section: string,
): Promise<string | null> {
  const filePath = path.join(GLOBAL_KNOWLEDGE, role, `${section}.md`);
  return readFile(filePath);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatLearningBlock(entry: LearningEntry): string {
  return [
    `### ${entry.title}`,
    `*${entry.timestamp} — ${entry.agent_id} (${entry.role})*`,
    entry.task_id !== null ? `*Task: ${entry.task_id}*` : "",
    "",
    entry.content,
    entry.tags.length > 0 ? `\n**Tags:** ${entry.tags.join(", ")}` : "",
    "",
    "---",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatDriftBlock(entry: DriftLearning): string {
  return [
    `### Drift Event: ${entry.title}`,
    `*${entry.timestamp} — ${entry.agent_id} (${entry.role})*`,
    entry.task_id !== null ? `*Task: ${entry.task_id}*` : "",
    "",
    `**Drift Score:** ${entry.drift_score.toFixed(3)}`,
    `**Root Cause:** ${entry.drift_cause}`,
    "",
    entry.content,
    "",
    `**Prevention Notes:** ${entry.prevention_notes}`,
    entry.tags.length > 0 ? `\n**Tags:** ${entry.tags.join(", ")}` : "",
    "",
    "---",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

async function appendMarkdownSection(
  filePath: string,
  content: string,
): Promise<void> {
  const existing = await readFile(filePath);
  if (existing === null) {
    // Initialize the file with a header
    const dir = path.dirname(filePath);
    const name = path.basename(filePath, ".md");
    const header = `# ${titleCase(name)}\n\n`;
    await writeFile(filePath, header + content);
  } else {
    await writeFile(filePath, existing + content);
  }
}

function titleCase(str: string): string {
  return str
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
