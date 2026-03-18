import path from "path";
import { randomUUID } from "crypto";
import {
  readMarkdownFile,
  writeMarkdownFile,
  writeFile,
  readFile,
} from "../io/fileStore.js";
import type {
  ApprovalFrontmatter,
  ApprovalType,
  ApprovalStatus,
  CouncilRecommendation,
  InboxItem,
} from "../types/index.js";

const APPROVALS_DIR = "state/approvals";
const INBOX_UNREAD_DIR = "state/inbox/tarantoga/unread";
const INBOX_URGENT_DIR = "state/inbox/tarantoga/urgent";

// ── Approval File Creation ────────────────────────────────────────────────────

export interface CreateApprovalOptions {
  readonly type: ApprovalType;
  readonly createdBy: string;
  readonly project: string | null;
  readonly councilRecommendation: CouncilRecommendation;
  readonly relatedTaskRefs: readonly string[];
  readonly body: string;
  readonly urgent?: boolean;
}

/**
 * Create a new approval request file in state/approvals/.
 * Adds a notification to Tarantoga's inbox.
 * Returns the approval ID and file path.
 */
export async function createApproval(
  options: CreateApprovalOptions,
): Promise<{ id: string; filePath: string }> {
  const id = `approval-${randomUUID()}`;
  const now = new Date().toISOString();
  const filePath = path.join(APPROVALS_DIR, `${id}.md`);

  const frontmatter: ApprovalFrontmatter = {
    id,
    schema_version: 1,
    type: options.type,
    status: "pending",
    created_at: now,
    updated_at: now,
    created_by: options.createdBy,
    project: options.project,
    council_recommendation: options.councilRecommendation,
    decision: null,
    decision_rationale: null,
    needs_more_research: false,
    research_request_ref: null,
    related_task_refs: options.relatedTaskRefs,
  };

  await writeMarkdownFile(
    filePath,
    frontmatter,
    options.body,
  );

  await notifyTarantoga({
    approvalId: id,
    type: options.type,
    project: options.project,
    urgent: options.urgent ?? false,
    createdAt: now,
  });

  return { id, filePath };
}

/**
 * Read an approval file by ID.
 * Returns null if not found.
 */
export async function readApproval(
  approvalId: string,
): Promise<{ frontmatter: ApprovalFrontmatter; body: string; rawContent: string } | null> {
  const filePath = path.join(APPROVALS_DIR, `${approvalId}.md`);
  return readMarkdownFile<ApprovalFrontmatter>(filePath);
}

/**
 * Update the status of an approval (orchestrator-only).
 * Agents signal decisions by editing the body — the orchestrator reads them
 * and calls this to update frontmatter.
 */
export async function updateApprovalStatus(
  approvalId: string,
  updates: Partial<Pick<ApprovalFrontmatter, "status" | "decision" | "decision_rationale" | "needs_more_research" | "research_request_ref">>,
): Promise<void> {
  const filePath = path.join(APPROVALS_DIR, `${approvalId}.md`);
  const doc = await readMarkdownFile<ApprovalFrontmatter>(filePath);
  if (doc === null) {
    throw new Error(`Approval not found: ${approvalId}`);
  }

  const updated: ApprovalFrontmatter = {
    ...doc.frontmatter,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  await writeMarkdownFile(
    filePath,
    updated,
    doc.body,
  );
}

// ── Inbox ──────────────────────────────────────────────────────────────────────

interface NotifyOptions {
  readonly approvalId: string;
  readonly type: ApprovalType;
  readonly project: string | null;
  readonly urgent: boolean;
  readonly createdAt: string;
}

async function notifyTarantoga(options: NotifyOptions): Promise<void> {
  const item: InboxItem = {
    id: `inbox-${randomUUID()}`,
    type: "approval_request",
    approval_ref: options.approvalId,
    title: formatApprovalTitle(options.type, options.project),
    summary: `New ${options.type} approval request${options.project ? ` for project ${options.project}` : ""}.`,
    created_at: options.createdAt,
    priority: options.urgent ? "urgent" : "normal",
  };

  const dir = options.urgent ? INBOX_URGENT_DIR : INBOX_UNREAD_DIR;
  const itemPath = path.join(dir, `${item.id}.json`);
  await writeFile(itemPath, JSON.stringify(item, null, 2));
}

function formatApprovalTitle(type: ApprovalType, project: string | null): string {
  const projectSuffix = project !== null ? ` — ${project}` : "";
  const labels: Record<ApprovalType, string> = {
    new_task: "New Task Request",
    new_mcp: "New MCP Server Request",
    new_crafter_type: "New Crafter Type Request",
    project_assignment: "Project Assignment",
    plan_approval: "Project Plan Approval",
    scope_change: "Scope Change Request",
    out_of_scope_finding: "Out-of-Scope Finding",
    task_cancellation: "Task Cancellation Request",
    design_decision: "Design Decision Approval",
    research_request: "Research Request",
    implementation_ambiguity: "Implementation Ambiguity",
  };
  return `${labels[type]}${projectSuffix}`;
}

// ── Inbox Read ─────────────────────────────────────────────────────────────────

/**
 * List all inbox items in a given folder.
 * Returns an array of InboxItem records, sorted by created_at ascending.
 */
export async function listInboxItems(
  folder: "unread" | "urgent" | "pending" | "deferred" | "archive",
): Promise<InboxItem[]> {
  const { promises: fs } = await import("fs");
  const dir = `state/inbox/tarantoga/${folder}`;

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const items: InboxItem[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const raw = await readFile(path.join(dir, entry));
    if (raw === null) continue;
    try {
      items.push(JSON.parse(raw) as InboxItem);
    } catch {
      // skip malformed files
    }
  }

  return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Move an inbox item from one folder to another. */
export async function moveInboxItem(
  itemId: string,
  fromFolder: string,
  toFolder: string,
): Promise<void> {
  const { promises: fs } = await import("fs");
  const from = `state/inbox/tarantoga/${fromFolder}/${itemId}.json`;
  const to = `state/inbox/tarantoga/${toFolder}/${itemId}.json`;
  await fs.rename(from, to);
}

export type { ApprovalStatus };
