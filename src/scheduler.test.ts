import { describe, it, expect } from "vitest";
import { hasCycle, sanitizePathSegment, MAX_CONCURRENT_AGENTS } from "./scheduler.js";

// ── 11b: hasCycle ──────────────────────────────────────────────────────────

describe("hasCycle", () => {
  it("returns false for a linear chain (A→B→C)", () => {
    const graph = new Map<string, readonly string[]>([
      ["A", ["B"]],
      ["B", ["C"]],
      ["C", []],
    ]);
    expect(hasCycle("A", graph)).toBe(false);
    expect(hasCycle("B", graph)).toBe(false);
    expect(hasCycle("C", graph)).toBe(false);
  });

  it("detects a 2-node cycle (A→B→A)", () => {
    const graph = new Map<string, readonly string[]>([
      ["A", ["B"]],
      ["B", ["A"]],
    ]);
    expect(hasCycle("A", graph)).toBe(true);
    expect(hasCycle("B", graph)).toBe(true);
  });

  it("detects a 3-node cycle (A→B→C→A)", () => {
    const graph = new Map<string, readonly string[]>([
      ["A", ["B"]],
      ["B", ["C"]],
      ["C", ["A"]],
    ]);
    expect(hasCycle("A", graph)).toBe(true);
  });

  it("detects a self-loop (A→A)", () => {
    const graph = new Map<string, readonly string[]>([
      ["A", ["A"]],
    ]);
    expect(hasCycle("A", graph)).toBe(true);
  });

  it("returns false for a diamond DAG (no cycle)", () => {
    const graph = new Map<string, readonly string[]>([
      ["A", ["B", "C"]],
      ["B", ["D"]],
      ["C", ["D"]],
      ["D", []],
    ]);
    expect(hasCycle("A", graph)).toBe(false);
  });

  it("returns false for disconnected node", () => {
    const graph = new Map<string, readonly string[]>([
      ["A", []],
      ["B", ["C"]],
      ["C", []],
    ]);
    expect(hasCycle("A", graph)).toBe(false);
  });

  it("returns false for node not in graph", () => {
    const graph = new Map<string, readonly string[]>();
    expect(hasCycle("missing", graph)).toBe(false);
  });

  it("handles a large chain (100 nodes) without stack overflow", () => {
    const graph = new Map<string, readonly string[]>();
    for (let i = 0; i < 100; i++) {
      graph.set(`node-${i}`, i < 99 ? [`node-${i + 1}`] : []);
    }
    expect(hasCycle("node-0", graph)).toBe(false);
  });

  it("detects cycle in large graph", () => {
    const graph = new Map<string, readonly string[]>();
    for (let i = 0; i < 100; i++) {
      graph.set(`node-${i}`, [`node-${(i + 1) % 100}`]);
    }
    expect(hasCycle("node-0", graph)).toBe(true);
  });
});

// ── 11c: sanitizePathSegment ────────────────────────────────────────────────

describe("sanitizePathSegment", () => {
  it("preserves normal IDs", () => {
    expect(sanitizePathSegment("task-001")).toBe("task-001");
  });

  it("replaces path separators", () => {
    expect(sanitizePathSegment("../../etc")).toBe("______etc");
  });

  it("replaces special characters", () => {
    expect(sanitizePathSegment("a:b.c")).toBe("a_b_c");
  });

  it("replaces backslashes", () => {
    expect(sanitizePathSegment("a\\b\\c")).toBe("a_b_c");
  });

  it("preserves underscores and hyphens", () => {
    expect(sanitizePathSegment("my_task-id")).toBe("my_task-id");
  });
});

// ── 11e: MAX_CONCURRENT_AGENTS export ───────────────────────────────────────

describe("MAX_CONCURRENT_AGENTS", () => {
  it("is exported and equals 8", () => {
    expect(MAX_CONCURRENT_AGENTS).toBe(8);
  });
});
