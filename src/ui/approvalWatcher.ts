/**
 * ApprovalWatcher — watches state/approvals/ and maintains an in-memory
 * map of all approval records. Broadcasts changes via callback.
 */
import path from "path";
import { Watcher } from "../io/watcher.js";
import { readMarkdownFile } from "../io/fileStore.js";
import type { ApprovalFrontmatter } from "../types/index.js";

export interface ApprovalRecord {
  readonly frontmatter: ApprovalFrontmatter;
  readonly body: string;
  readonly filePath: string;
}

export class ApprovalWatcher {
  readonly #watcher: Watcher;
  readonly #approvals = new Map<string, ApprovalRecord>();
  readonly #onUpdate: (record: ApprovalRecord) => void;
  #closed = false;

  constructor(onUpdate: (record: ApprovalRecord) => void) {
    this.#onUpdate = onUpdate;
    this.#watcher = Watcher.create(
      ["state/approvals/**/*.md"],
      (event, filePath) => { void this.#handleFile(event, filePath); },
    );
  }

  async #handleFile(event: "add" | "change" | "unlink", filePath: string): Promise<void> {
    if (this.#closed) return;

    if (event === "unlink") {
      this.#approvals.delete(path.basename(filePath, ".md"));
      return;
    }

    const doc = await readMarkdownFile<ApprovalFrontmatter>(filePath);
    if (doc === null) return;

    const record: ApprovalRecord = {
      frontmatter: doc.frontmatter,
      body: doc.body,
      filePath,
    };
    this.#approvals.set(doc.frontmatter.id, record);
    this.#onUpdate(record);
  }

  getAll(): ApprovalRecord[] {
    return Array.from(this.#approvals.values());
  }

  get(id: string): ApprovalRecord | undefined {
    return this.#approvals.get(id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#watcher.close();
  }
}
