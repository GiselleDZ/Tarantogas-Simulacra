/**
 * ActivityWatcher — watches state/tasks/**\/*.md for PHASE:/DECISION: log lines.
 * Emits structured ActivityEvent objects via callback and maintains a ring buffer.
 */
import { Watcher } from "../io/watcher.js";
import { readMarkdownFile } from "../io/fileStore.js";
import { parseAgentLogLines } from "../io/agentLog.js";
import type { AgentLogRole } from "../io/agentLog.js";
import type { TaskFrontmatter, TaskStatus } from "../types/index.js";

export type { AgentLogRole };

export interface ActivityEvent {
  readonly id: string;        // "evt-{counter}" — monotonically increasing
  readonly taskId: string;
  readonly project: string;
  readonly role: AgentLogRole;
  readonly agentId: string;
  readonly type: "PHASE" | "DECISION";
  readonly message: string;
  readonly timestamp: string; // ISO, set at time of detection
}

const RING_BUFFER_SIZE = 500;

let eventCounter = 0;

function statusToRole(status: TaskStatus): AgentLogRole {
  if (status === "research_pending") return "research";
  if (status === "in_progress" || status === "crafter_revision" || status === "assigned") return "crafter";
  if (status === "steward_review" || status === "steward_final") return "steward";
  return "council";
}

function getAgentId(frontmatter: TaskFrontmatter, status: TaskStatus): string {
  if (status === "in_progress" || status === "crafter_revision" || status === "assigned") {
    return frontmatter.assigned_crafter ?? "unknown";
  }
  if (status === "steward_review" || status === "steward_final") {
    return frontmatter.assigned_steward ?? "unknown";
  }
  if (status === "council_peer_review") {
    return frontmatter.assigned_council_peer ?? "unknown";
  }
  if (status === "research_pending") return "research";
  return frontmatter.assigned_council_author ?? "unknown";
}

export class ActivityWatcher {
  readonly #watcher: Watcher;
  readonly #offsets = new Map<string, number>();
  readonly #buffer: ActivityEvent[] = [];
  readonly #onEvents: (events: ActivityEvent[]) => void;
  #closed = false;

  constructor(onEvents: (events: ActivityEvent[]) => void) {
    this.#onEvents = onEvents;
    this.#watcher = Watcher.create(
      ["state/tasks/**/*.md"],
      (event, filePath) => { void this.#handleFile(event, filePath); },
    );
  }

  async #handleFile(event: "add" | "change" | "unlink", filePath: string): Promise<void> {
    if (this.#closed) return;

    if (event === "unlink") {
      this.#offsets.delete(filePath);
      return;
    }

    const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
    if (doc === null) return;

    const previousOffset = this.#offsets.get(filePath) ?? 0;
    const newContent = doc.body.slice(previousOffset);
    const lines = parseAgentLogLines(newContent);

    this.#offsets.set(filePath, doc.body.length);

    if (lines.length === 0) return;

    const { frontmatter } = doc;
    const role = statusToRole(frontmatter.status);
    const agentId = getAgentId(frontmatter, frontmatter.status);
    const timestamp = new Date().toISOString();

    const events: ActivityEvent[] = lines.map((line) => ({
      id: `evt-${++eventCounter}`,
      taskId: frontmatter.id,
      project: frontmatter.project,
      role,
      agentId,
      type: line.type,
      message: line.message,
      timestamp,
    }));

    this.#buffer.push(...events);
    if (this.#buffer.length > RING_BUFFER_SIZE) {
      this.#buffer.splice(0, this.#buffer.length - RING_BUFFER_SIZE);
    }

    this.#onEvents(events);
  }

  getRecent(): ActivityEvent[] {
    return [...this.#buffer];
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#watcher.close();
  }
}
