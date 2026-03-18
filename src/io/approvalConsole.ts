/**
 * ApprovalConsole — interactive terminal interface for Tarantoga to review approvals.
 *
 * Watches state/approvals/ for new files with status: pending.
 * Auto-approves task_cancellation and drift notifications per system policy.
 * Prompts Tarantoga interactively for all other approval types.
 * Processes approvals sequentially via an internal FIFO queue.
 */
import readline from "readline";
import path from "path";
import { Watcher } from "./watcher.js";
import { readMarkdownFile } from "./fileStore.js";
import { FileLock } from "./lock.js";
import { updateApprovalStatus } from "../workflow/approvalQueue.js";
import type { ApprovalFrontmatter, ApprovalType, ApprovalDecision } from "../types/index.js";

const AUTO_APPROVE_TYPES: readonly ApprovalType[] = ["task_cancellation"];

const PROMPT_LINE = "[y] approve  [n] decline  [d] defer  [p] pending\nDecision: ";

/** Callback invoked after Tarantoga makes a final decision on an approval. */
export type ApprovalDecidedCallback = (
  approvalId: string,
  type: ApprovalType,
  decision: ApprovalDecision,
  project: string | null,
  relatedTaskRefs: readonly string[],
) => Promise<void>;

export class ApprovalConsole {
  readonly #watcher: Watcher;
  readonly #queue: string[];
  readonly #onApprovalDecided: ApprovalDecidedCallback | undefined;
  readonly #autoOnly: boolean;
  #processing: boolean;
  #closed: boolean;

  /** @param autoOnly When true, only auto-approvals run; interactive prompts are suppressed (UI handles decisions). */
  constructor(onApprovalDecided?: ApprovalDecidedCallback, autoOnly = false) {
    this.#autoOnly = autoOnly;
    this.#queue = [];
    this.#processing = false;
    this.#closed = false;
    this.#onApprovalDecided = onApprovalDecided;

    this.#watcher = Watcher.create(
      ["state/approvals/**/*.md"],
      (event, filePath) => {
        void this.#handleFile(event, filePath);
      },
    );
  }

  async #handleFile(event: "add" | "change" | "unlink", filePath: string): Promise<void> {
    if (this.#closed) return;
    if (event !== "add" && event !== "change") return;
    if (!filePath.endsWith(".md")) return;

    const doc = await readMarkdownFile<ApprovalFrontmatter>(filePath);
    if (doc === null) return;
    if (doc.frontmatter.status !== "pending") return;

    const { id, type } = doc.frontmatter;

    if (AUTO_APPROVE_TYPES.includes(type)) {
      await this.#autoApprove(id, type);
      return;
    }

    if (!this.#queue.includes(id)) {
      this.#queue.push(id);
      void this.#drainQueue();
    }
  }

  async #autoApprove(approvalId: string, type: ApprovalType): Promise<void> {
    const filePath = path.join("state/approvals", `${approvalId}.md`);
    const lock = new FileLock(filePath);

    await lock.withLock(async () => {
      await updateApprovalStatus(approvalId, {
        status: "decided",
        decision: "approved",
        decision_rationale: `Auto-approved: ${type} is on the system auto-approve list.`,
      });
    });

    console.log(`[ApprovalConsole] Auto-approved ${type} (${approvalId})`);
  }

  async #drainQueue(): Promise<void> {
    if (this.#processing || this.#closed) return;
    this.#processing = true;

    while (this.#queue.length > 0 && !this.#closed) {
      const id = this.#queue[0];
      if (id !== undefined) {
        await this.#promptApproval(id);
      }
      this.#queue.shift();
    }

    this.#processing = false;
  }

  async #promptApproval(approvalId: string): Promise<void> {
    const filePath = path.join("state/approvals", `${approvalId}.md`);
    const doc = await readMarkdownFile<ApprovalFrontmatter>(filePath);

    if (doc === null || doc.frontmatter.status !== "pending") return;

    const { type, created_by, project, council_recommendation } = doc.frontmatter;
    const divider = "─".repeat(60);

    console.log(`\n${divider}`);
    console.log(`[APPROVAL REQUEST]`);
    console.log(`  ID:          ${approvalId}`);
    console.log(`  Type:        ${type}`);
    console.log(`  From:        ${created_by}`);
    console.log(`  Project:     ${project ?? "(none)"}`);
    console.log(`  Council rec: ${council_recommendation}`);
    console.log(divider);

    const preview = doc.body.trimStart().slice(0, 600);
    if (preview.length > 0) {
      console.log(preview);
      if (doc.body.length > 600) console.log("  [...truncated — read full file for details]");
    }
    console.log(divider);

    if (this.#autoOnly) {
      console.log(`[ApprovalConsole] UI mode — leaving ${approvalId} pending for web dashboard.`);
      return;
    }

    if (!process.stdin.isTTY) {
      console.log("[ApprovalConsole] stdin is not a TTY — leaving approval pending for manual review.");
      return;
    }

    const answer = await promptQuestion(PROMPT_LINE);
    await this.#applyDecision(approvalId, filePath, answer.trim().toLowerCase());
  }

  async #applyDecision(approvalId: string, filePath: string, answer: string): Promise<void> {
    const decisionMap: Record<string, ApprovalDecision | "noop"> = {
      y: "approved",
      n: "declined",
      d: "deferred",
      p: "noop",
    };

    const decision = decisionMap[answer];

    if (decision === undefined) {
      console.log("[ApprovalConsole] Unrecognised input — leaving approval pending.");
      return;
    }

    if (decision === "noop") {
      // Mark as in_conversation so the watcher does not re-queue it on next file change
      const lock = new FileLock(filePath);
      await lock.withLock(async () => {
        await updateApprovalStatus(approvalId, { status: "in_conversation" });
      });
      console.log("[ApprovalConsole] Noted — marked in_conversation. Decide later.");
      return;
    }

    // Read frontmatter before the lock so we can pass it to the callback
    const doc = await readMarkdownFile<ApprovalFrontmatter>(filePath);

    const lock = new FileLock(filePath);
    await lock.withLock(async () => {
      await updateApprovalStatus(approvalId, {
        status: "decided",
        decision,
        decision_rationale: `Set by Tarantoga via console at ${new Date().toISOString()}.`,
      });
    });

    console.log(`[ApprovalConsole] Decision recorded: ${decision}`);

    if (this.#onApprovalDecided !== undefined && doc !== null) {
      await this.#onApprovalDecided(
        approvalId,
        doc.frontmatter.type,
        decision,
        doc.frontmatter.project,
        doc.frontmatter.related_task_refs,
      ).catch((err: unknown) => {
        console.error(`[ApprovalConsole] onApprovalDecided callback error:`, err);
      });
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#watcher.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function promptQuestion(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
