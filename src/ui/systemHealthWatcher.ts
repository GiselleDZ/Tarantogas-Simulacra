/**
 * SystemHealthWatcher — watches live agents, drift events, structured logs,
 * and project costs. Emits updates via callback and maintains in-memory state.
 */
import path from "path";
import { Watcher } from "../io/watcher.js";
import { readFile } from "../io/fileStore.js";
import type {
  AgentIdentity,
  AgentRole,
  AgentCostEntry,
  LiveAgentRegistry,
  DriftSeverity,
  DriftAction,
  ProjectRegistry,
} from "../types/index.js";
import type { LogEntry, LogLevel } from "../io/logger.js";

// ── Exported types ─────────────────────────────────────────────────────────────

export interface LiveAgentSnapshot {
  readonly id: string;
  readonly role: AgentRole;
  readonly crafter_type?: string;
  readonly spawned_at: string;
  readonly pid: number;
  readonly task_id?: string;
  readonly project_slug?: string;
  readonly uptime_ms: number;
}

export interface DriftEventSnapshot {
  readonly id: string;
  readonly agent_id: string;
  readonly agent_role: AgentRole;
  readonly score: number;
  readonly severity: DriftSeverity;
  readonly timestamp: string;
  readonly action_taken: DriftAction;
}

export interface SystemLogEvent {
  readonly t: string;
  readonly lvl: LogLevel;
  readonly c: string;
  readonly ev: string;
  readonly agent_id?: string;
  readonly project?: string;
  readonly task_id?: string;
  readonly cost_usd?: number;
  readonly duration_ms?: number;
  readonly msg?: string;
}

export interface CostSummary {
  readonly global_total_usd: number;
  readonly per_project: readonly { slug: string; total_usd: number; entry_count: number }[];
}

export interface SystemHealthSnapshot {
  readonly agents: LiveAgentSnapshot[];
  readonly drift_events: DriftEventSnapshot[];
  readonly system_events: SystemLogEvent[];
  readonly costs: CostSummary;
}

export type SystemHealthUpdate =
  | { section: "agents";        agents: LiveAgentSnapshot[] }
  | { section: "drift_events";  events: DriftEventSnapshot[] }
  | { section: "system_events"; events: SystemLogEvent[] }
  | { section: "costs";         costs: CostSummary };

// ── Constants ──────────────────────────────────────────────────────────────────

const DRIFT_BUFFER_SIZE = 100;
const SYSTEM_EVENT_BUFFER_SIZE = 200;

const RELEVANT_LOG_EVENTS = new Set([
  "agent_spawn",
  "agent_done",
  "agent_fail",
  "agent_timeout",
]);

// ── Pure helpers (exported for testing) ────────────────────────────────────────

export function mapRegistryToSnapshots(
  registry: LiveAgentRegistry,
  now: number,
): LiveAgentSnapshot[] {
  return Object.values(registry).map((agent: AgentIdentity) => ({
    id: agent.id,
    role: agent.role,
    ...(agent.crafter_type !== undefined ? { crafter_type: agent.crafter_type } : {}),
    spawned_at: agent.spawned_at,
    pid: agent.pid,
    ...(agent.task_id !== undefined ? { task_id: agent.task_id } : {}),
    ...(agent.project_slug !== undefined ? { project_slug: agent.project_slug } : {}),
    uptime_ms: now - new Date(agent.spawned_at).getTime(),
  }));
}

export function parseDriftLines(raw: string): DriftEventSnapshot[] {
  if (raw.trim().length === 0) return [];
  const results: DriftEventSnapshot[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      results.push({
        id: entry.id as string,
        agent_id: entry.agent_id as string,
        agent_role: entry.agent_role as AgentRole,
        score: entry.score as number,
        severity: entry.severity as DriftSeverity,
        timestamp: entry.timestamp as string,
        action_taken: entry.action_taken as DriftAction,
      });
    } catch {
      // Skip malformed lines
    }
  }
  return results;
}

export function parseAndFilterLogLines(raw: string): SystemLogEvent[] {
  if (raw.trim().length === 0) return [];
  const results: SystemLogEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (!RELEVANT_LOG_EVENTS.has(entry.ev)) continue;
      const mapped: SystemLogEvent = {
        t: entry.t,
        lvl: entry.lvl,
        c: entry.c,
        ev: entry.ev,
        ...(entry.agent_id !== undefined ? { agent_id: entry.agent_id } : {}),
        ...(entry.project !== undefined ? { project: entry.project } : {}),
        ...(entry.task_id !== undefined ? { task_id: entry.task_id } : {}),
        ...(entry.cost_usd !== undefined ? { cost_usd: entry.cost_usd } : {}),
        ...(entry.duration_ms !== undefined ? { duration_ms: entry.duration_ms } : {}),
        ...(entry.msg !== undefined ? { msg: entry.msg } : {}),
      };
      results.push(mapped);
    } catch {
      // Skip malformed lines
    }
  }
  return results;
}

export function computeCostSummary(
  projectCosts: Map<string, AgentCostEntry[]>,
): CostSummary {
  let globalTotal = 0;
  const perProject: { slug: string; total_usd: number; entry_count: number }[] = [];

  for (const [slug, entries] of projectCosts) {
    const total = entries.reduce((sum, e) => sum + e.cost_usd, 0);
    globalTotal += total;
    perProject.push({ slug, total_usd: total, entry_count: entries.length });
  }

  return { global_total_usd: globalTotal, per_project: perProject };
}

// ── Watcher class ──────────────────────────────────────────────────────────────

export class SystemHealthWatcher {
  readonly #registryWatcher: Watcher;
  readonly #driftWatcher: Watcher;
  readonly #logWatcher: Watcher;

  #agents: LiveAgentSnapshot[] = [];
  readonly #driftBuffer: DriftEventSnapshot[] = [];
  readonly #eventBuffer: SystemLogEvent[] = [];
  #costs: CostSummary = { global_total_usd: 0, per_project: [] };

  #driftOffset = 0;
  #logOffset = 0;
  #closed = false;

  readonly #onUpdate: (update: SystemHealthUpdate) => void;

  constructor(onUpdate: (update: SystemHealthUpdate) => void) {
    this.#onUpdate = onUpdate;

    this.#registryWatcher = Watcher.create(
      ["state/agents/live.json"],
      (_event, filePath) => { void this.#handleRegistryChange(filePath); },
    );

    this.#driftWatcher = Watcher.create(
      ["state/drift/events.jsonl"],
      (_event, filePath) => { void this.#handleDriftChange(filePath); },
    );

    this.#logWatcher = Watcher.create(
      ["logs/structured.jsonl"],
      (_event, filePath) => { void this.#handleLogChange(filePath); },
    );
  }

  // ── Registry handler ─────────────────────────────────────────────────────

  async #handleRegistryChange(filePath: string): Promise<void> {
    if (this.#closed) return;
    const raw = await readFile(filePath);
    if (raw === null) { this.#agents = []; return; }
    try {
      const registry = JSON.parse(raw) as LiveAgentRegistry;
      this.#agents = mapRegistryToSnapshots(registry, Date.now());
      this.#onUpdate({ section: "agents", agents: this.#agents });
    } catch {
      // Invalid JSON — keep previous state
    }
  }

  // ── Drift handler (incremental) ──────────────────────────────────────────

  async #handleDriftChange(filePath: string): Promise<void> {
    if (this.#closed) return;
    const raw = await readFile(filePath);
    if (raw === null) return;

    const newContent = raw.slice(this.#driftOffset);
    this.#driftOffset = raw.length;

    const newEvents = parseDriftLines(newContent);
    if (newEvents.length === 0) return;

    this.#driftBuffer.push(...newEvents);
    if (this.#driftBuffer.length > DRIFT_BUFFER_SIZE) {
      this.#driftBuffer.splice(0, this.#driftBuffer.length - DRIFT_BUFFER_SIZE);
    }

    this.#onUpdate({ section: "drift_events", events: newEvents });
  }

  // ── Log handler (incremental) ────────────────────────────────────────────

  async #handleLogChange(filePath: string): Promise<void> {
    if (this.#closed) return;
    const raw = await readFile(filePath);
    if (raw === null) return;

    const newContent = raw.slice(this.#logOffset);
    this.#logOffset = raw.length;

    const newEvents = parseAndFilterLogLines(newContent);
    if (newEvents.length === 0) return;

    this.#eventBuffer.push(...newEvents);
    if (this.#eventBuffer.length > SYSTEM_EVENT_BUFFER_SIZE) {
      this.#eventBuffer.splice(0, this.#eventBuffer.length - SYSTEM_EVENT_BUFFER_SIZE);
    }

    this.#onUpdate({ section: "system_events", events: newEvents });

    // If any log entry has cost_usd, refresh the cost summary
    if (newEvents.some((e) => e.cost_usd !== undefined)) {
      await this.#refreshCosts();
    }
  }

  // ── Cost refresh ─────────────────────────────────────────────────────────

  async #refreshCosts(): Promise<void> {
    const registryRaw = await readFile(path.resolve("state/projects/registry.json"));
    if (registryRaw === null) return;

    let projects: ProjectRegistry[];
    try {
      const parsed = JSON.parse(registryRaw) as Record<string, ProjectRegistry>;
      projects = Object.values(parsed);
    } catch {
      return;
    }

    const costMap = new Map<string, AgentCostEntry[]>();
    for (const project of projects) {
      const costsPath = path.resolve(`state/projects/${project.slug}/costs.jsonl`);
      const raw = await readFile(costsPath);
      if (raw === null) continue;
      const entries: AgentCostEntry[] = raw
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as AgentCostEntry);
      costMap.set(project.slug, entries);
    }

    this.#costs = computeCostSummary(costMap);
    this.#onUpdate({ section: "costs", costs: this.#costs });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  getSnapshot(): SystemHealthSnapshot {
    return {
      agents: [...this.#agents],
      drift_events: [...this.#driftBuffer],
      system_events: [...this.#eventBuffer],
      costs: this.#costs,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([
      this.#registryWatcher.close(),
      this.#driftWatcher.close(),
      this.#logWatcher.close(),
    ]);
  }
}
