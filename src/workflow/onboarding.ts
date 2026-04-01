import path from "path";
import { randomUUID } from "crypto";
import { writeMarkdownFile, readMarkdownFile, writeFile } from "../io/fileStore.js";
import { createApproval } from "./approvalQueue.js";
import { ensureGitignore } from "./gitignoreGenerator.js";
import type { ProjectRegistry, ProjectStatus } from "../types/index.js";

const PROJECTS_REGISTRY = "state/projects/registry.json";
const PROJECTS_DIR = "state/projects";

// ── Project Registry ──────────────────────────────────────────────────────────

async function readProjectRegistry(): Promise<Record<string, ProjectRegistry>> {
  const { promises: fs } = await import("fs");
  const raw = await fs.readFile(PROJECTS_REGISTRY, "utf-8").catch(() => "{}");
  return JSON.parse(raw) as Record<string, ProjectRegistry>;
}

async function writeProjectRegistry(
  registry: Record<string, ProjectRegistry>,
): Promise<void> {
  await writeFile(PROJECTS_REGISTRY, JSON.stringify(registry, null, 2));
}

// ── Onboarding ────────────────────────────────────────────────────────────────

export interface OnboardProjectOptions {
  readonly name: string;
  readonly path: string;
  readonly crafterTypes: readonly string[];
  readonly requestedBy: string;
}

/**
 * Initiate project onboarding.
 * Creates the project registry entry and sends a project_assignment
 * approval request to Tarantoga's inbox.
 */
export async function onboardProject(
  options: OnboardProjectOptions,
): Promise<{ slug: string; approvalId: string }> {
  const slug = slugify(options.name);
  const now = new Date().toISOString();

  const entry: ProjectRegistry = {
    slug,
    name: options.name,
    path: options.path,
    status: "onboarding_requested",
    created_at: now,
    updated_at: now,
    crafter_types: options.crafterTypes,
    active_task_ids: [],
  };

  // Persist to registry
  const registry = await readProjectRegistry();
  const updated = { ...registry, [slug]: entry };
  await writeProjectRegistry(updated);

  // Create project directory in state/
  await writeFile(
    `state/projects/${slug}/README.md`,
    `# Project: ${options.name}\n\nSlug: \`${slug}\`\nStatus: onboarding_requested\n`,
  );

  // Send approval request
  const { id: approvalId } = await createApproval({
    type: "project_assignment",
    createdBy: options.requestedBy,
    project: slug,
    councilRecommendation: "approve",
    relatedTaskRefs: [],
    body: `## Project Onboarding Request\n\n**Name:** ${options.name}\n**Path:** ${options.path}\n**Crafter Types:** ${options.crafterTypes.join(", ")}\n\nThis project is awaiting Tarantoga approval before Council begins planning.\n`,
    urgent: false,
  });

  return { slug, approvalId };
}

/**
 * Activate a project after Tarantoga approves the onboarding.
 * Sets status to "kickoff_pending" so the scheduler spawns a Council kickoff agent.
 * Also creates the project's task and knowledge directories.
 */
export async function activateProject(slug: string): Promise<void> {
  const { promises: fs } = await import("fs");

  const registry = await readProjectRegistry();
  const entry = registry[slug];
  if (entry === undefined) {
    throw new Error(`Project not found: ${slug}`);
  }

  const updated: ProjectRegistry = {
    ...entry,
    status: "kickoff_pending" as ProjectStatus,
    updated_at: new Date().toISOString(),
  };

  await writeProjectRegistry({ ...registry, [slug]: updated });

  // Ensure directory structure exists
  const dirs = [
    `state/tasks/${slug}`,
    `state/knowledge/projects/${slug}`,
    ...entry.crafter_types.map((ct) => `state/knowledge/projects/${slug}/${ct}`),
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Generate .gitignore for the project repo before agents touch it
  try {
    await ensureGitignore(entry.path);
  } catch (err: unknown) {
    console.warn(`[Onboarding] Failed to generate .gitignore for ${slug}:`, err);
  }
}

/**
 * Set a project's status to any ProjectStatus.
 * Used by the orchestrator to react to approval decisions without
 * coupling approval logic to the full onboarding domain actions.
 */
export async function setProjectStatus(
  slug: string,
  status: ProjectStatus,
): Promise<void> {
  const registry = await readProjectRegistry();
  const entry = registry[slug];
  if (entry === undefined) {
    throw new Error(`Project not found: ${slug}`);
  }
  const updated: ProjectRegistry = {
    ...entry,
    status,
    updated_at: new Date().toISOString(),
  };
  await writeProjectRegistry({ ...registry, [slug]: updated });
}

/**
 * List all projects, optionally filtered by status.
 */
export async function listProjects(
  status?: ProjectStatus,
): Promise<ProjectRegistry[]> {
  const registry = await readProjectRegistry();
  const all = Object.values(registry);
  return status !== undefined
    ? all.filter((p) => p.status === status)
    : all;
}

/**
 * Get a single project by slug.
 */
export async function getProject(
  slug: string,
): Promise<ProjectRegistry | null> {
  const registry = await readProjectRegistry();
  return registry[slug] ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
