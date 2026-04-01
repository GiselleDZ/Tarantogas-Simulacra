import { describe, it, expect } from "vitest";
import {
  mapRegistryToSnapshots,
  parseDriftLines,
  parseAndFilterLogLines,
  computeCostSummary,
} from "./systemHealthWatcher.js";
import type { LiveAgentRegistry, AgentCostEntry } from "../types/index.js";

describe("mapRegistryToSnapshots", () => {
  it("returns [] for an empty registry", () => {
    expect(mapRegistryToSnapshots({}, Date.now())).toEqual([]);
  });

  it("maps multiple agents with correct fields and uptime_ms", () => {
    const now = Date.now();
    const registry: LiveAgentRegistry = {
      "council-1": {
        id: "council-1",
        role: "council",
        spawned_at: new Date(now - 60_000).toISOString(),
        pid: 1234,
        task_id: "task-1",
        project_slug: "alpha",
      },
      "crafter-2": {
        id: "crafter-2",
        role: "crafter",
        crafter_type: "frontend",
        spawned_at: new Date(now - 120_000).toISOString(),
        pid: 5678,
      },
    };

    const result = mapRegistryToSnapshots(registry, now);

    expect(result).toHaveLength(2);

    const c1 = result.find((a) => a.id === "council-1")!;
    expect(c1.role).toBe("council");
    expect(c1.pid).toBe(1234);
    expect(c1.task_id).toBe("task-1");
    expect(c1.project_slug).toBe("alpha");
    expect(c1.uptime_ms).toBe(60_000);

    const c2 = result.find((a) => a.id === "crafter-2")!;
    expect(c2.role).toBe("crafter");
    expect(c2.crafter_type).toBe("frontend");
    expect(c2.uptime_ms).toBe(120_000);
  });
});

describe("parseDriftLines", () => {
  it("parses valid JSONL into snapshots", () => {
    const lines = [
      JSON.stringify({
        id: "d1", agent_id: "a1", agent_role: "council", task_id: "t1",
        score: 0.95, severity: "nominal", timestamp: "2026-01-01T00:00:00Z",
        action_taken: "none",
      }),
      JSON.stringify({
        id: "d2", agent_id: "a2", agent_role: "crafter", task_id: null,
        score: 0.4, severity: "reinject", timestamp: "2026-01-01T01:00:00Z",
        action_taken: "reinject_persona_anchor",
      }),
    ].join("\n");

    const result = parseDriftLines(lines);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "d1", agent_id: "a1", agent_role: "council", score: 0.95,
      severity: "nominal", timestamp: "2026-01-01T00:00:00Z",
      action_taken: "none",
    });
    expect(result[1]).toEqual({
      id: "d2", agent_id: "a2", agent_role: "crafter", score: 0.4,
      severity: "reinject", timestamp: "2026-01-01T01:00:00Z",
      action_taken: "reinject_persona_anchor",
    });
  });

  it("skips malformed JSONL lines", () => {
    const lines = [
      JSON.stringify({ id: "d1", agent_id: "a1", agent_role: "council", score: 0.9, severity: "nominal", timestamp: "t1", action_taken: "none" }),
      "NOT VALID JSON {{{",
      "",
      JSON.stringify({ id: "d2", agent_id: "a2", agent_role: "crafter", score: 0.5, severity: "monitor", timestamp: "t2", action_taken: "monitor" }),
    ].join("\n");

    const result = parseDriftLines(lines);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("d1");
    expect(result[1]!.id).toBe("d2");
  });

  it("returns [] for empty string", () => {
    expect(parseDriftLines("")).toEqual([]);
  });
});

describe("parseAndFilterLogLines", () => {
  it("filters to only relevant agent lifecycle events", () => {
    const lines = [
      JSON.stringify({ t: "2026-01-01T00:00:00Z", lvl: "info", c: "Spawner", ev: "agent_spawn", agent_id: "a1" }),
      JSON.stringify({ t: "2026-01-01T00:01:00Z", lvl: "info", c: "Scheduler", ev: "tick", msg: "heartbeat" }),
      JSON.stringify({ t: "2026-01-01T00:02:00Z", lvl: "info", c: "Spawner", ev: "agent_done", agent_id: "a1", cost_usd: 0.05 }),
      JSON.stringify({ t: "2026-01-01T00:03:00Z", lvl: "error", c: "Spawner", ev: "agent_fail", agent_id: "a2" }),
      JSON.stringify({ t: "2026-01-01T00:04:00Z", lvl: "warn", c: "Spawner", ev: "agent_timeout", agent_id: "a3", duration_ms: 30000 }),
    ].join("\n");

    const result = parseAndFilterLogLines(lines);
    expect(result).toHaveLength(4);
    expect(result.map((e) => e.ev)).toEqual(["agent_spawn", "agent_done", "agent_fail", "agent_timeout"]);
    expect(result[0]!.agent_id).toBe("a1");
    expect(result[1]!.cost_usd).toBe(0.05);
    expect(result[3]!.duration_ms).toBe(30000);
  });

  it("returns [] for empty string", () => {
    expect(parseAndFilterLogLines("")).toEqual([]);
  });
});

describe("computeCostSummary", () => {
  it("computes correct totals for multiple projects", () => {
    const entries = new Map<string, AgentCostEntry[]>([
      ["alpha", [
        { agent_id: "a1", role: "crafter", cost_usd: 0.10, duration_ms: 1000, timestamp: "t1" },
        { agent_id: "a2", role: "council", cost_usd: 0.25, duration_ms: 2000, timestamp: "t2" },
      ]],
      ["beta", [
        { agent_id: "a3", role: "steward", cost_usd: 0.05, duration_ms: 500, timestamp: "t3" },
      ]],
    ]);

    const result = computeCostSummary(entries);
    expect(result.global_total_usd).toBeCloseTo(0.40);
    expect(result.per_project).toHaveLength(2);

    const alpha = result.per_project.find((p) => p.slug === "alpha")!;
    expect(alpha.total_usd).toBeCloseTo(0.35);
    expect(alpha.entry_count).toBe(2);

    const beta = result.per_project.find((p) => p.slug === "beta")!;
    expect(beta.total_usd).toBeCloseTo(0.05);
    expect(beta.entry_count).toBe(1);
  });

  it("returns zeroed summary for empty map", () => {
    const result = computeCostSummary(new Map());
    expect(result).toEqual({ global_total_usd: 0, per_project: [] });
  });
});
