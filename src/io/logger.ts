/**
 * Structured event logger.
 * Appends JSON lines to logs/structured.jsonl for offline querying.
 * Fire-and-forget — callers do not need to await.
 */
import { appendLine } from "./fileStore.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  readonly t: string;           // ISO timestamp
  readonly lvl: LogLevel;
  readonly c: string;           // component (Spawner, Scheduler, Pipeline, …)
  readonly ev: string;          // event name
  readonly agent_id?: string;
  readonly project?: string;
  readonly task_id?: string;
  readonly cost_usd?: number;
  readonly duration_ms?: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

const LOG_PATH = "logs/structured.jsonl";

/**
 * Append a structured log entry to logs/structured.jsonl.
 * Non-blocking: errors are silently dropped so logging never blocks the hot path.
 */
export function logEvent(entry: LogEntry): void {
  appendLine(LOG_PATH, JSON.stringify(entry)).catch(() => undefined);
}
