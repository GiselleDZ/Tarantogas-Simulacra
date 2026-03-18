/**
 * TaskWatcher — watches state/tasks/**\/*.md and maintains an in-memory
 * map of all task records. Broadcasts changes via callback.
 */
import path from "path";
import { Watcher } from "../io/watcher.js";
import { readMarkdownFile } from "../io/fileStore.js";
import type { TaskFrontmatter } from "../types/index.js";

export interface TaskRecord {
  readonly frontmatter: TaskFrontmatter;
  readonly body: string;
  readonly filePath: string;
}

export class TaskWatcher {
  readonly #watcher: Watcher;
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #onUpdate: (task: TaskRecord) => void;
  #closed = false;

  constructor(onUpdate: (task: TaskRecord) => void) {
    this.#onUpdate = onUpdate;
    this.#watcher = Watcher.create(
      ["state/tasks/**/*.md"],
      (event, filePath) => { void this.#handleFile(event, filePath); },
    );
  }

  async #handleFile(event: "add" | "change" | "unlink", filePath: string): Promise<void> {
    if (this.#closed) return;

    if (event === "unlink") {
      for (const [id, record] of this.#tasks) {
        if (record.filePath === filePath) { this.#tasks.delete(id); break; }
      }
      return;
    }

    const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
    if (doc === null) return;

    const record: TaskRecord = { frontmatter: doc.frontmatter, body: doc.body, filePath };
    this.#tasks.set(doc.frontmatter.id, record);
    this.#onUpdate(record);
  }

  getAll(): TaskRecord[] {
    return Array.from(this.#tasks.values());
  }

  getByProject(slug: string): TaskRecord[] {
    return Array.from(this.#tasks.values()).filter(
      (t) => t.frontmatter.project === slug,
    );
  }

  get(id: string): TaskRecord | undefined {
    return this.#tasks.get(id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#watcher.close();
  }
}
