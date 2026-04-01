import { describe, it, expect } from "vitest";
import { hasCycle, sanitizePathSegment, MAX_CONCURRENT_AGENTS, findStuckKickoffs, hasCompletedResearch } from "./scheduler.js";
import type { ProjectRegistry, LiveAgentRegistry } from "./types/index.js";

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

// ── findStuckKickoffs ──────────────────────────────────────────────────────

function makeProject(slug: string, status: string, updatedAt: string): ProjectRegistry {
  return {
    slug,
    name: slug,
    path: `/path/${slug}`,
    status: status as ProjectRegistry["status"],
    created_at: updatedAt,
    updated_at: updatedAt,
    crafter_types: ["frontend"],
    active_task_ids: [],
  };
}

describe("findStuckKickoffs", () => {
  const oldTimestamp = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
  const freshTimestamp = new Date(Date.now() - 5_000).toISOString(); // 5 sec ago

  it("returns slugs of kickoff_in_progress projects with no live council agent", () => {
    const projects = [makeProject("alpha", "kickoff_in_progress", oldTimestamp)];
    const registry: LiveAgentRegistry = {};
    expect(findStuckKickoffs(projects, registry)).toEqual(["alpha"]);
  });

  it("skips projects that are not kickoff_in_progress", () => {
    const projects = [
      makeProject("a", "active", oldTimestamp),
      makeProject("b", "kickoff_pending", oldTimestamp),
      makeProject("c", "kickoff_failed", oldTimestamp),
    ];
    expect(findStuckKickoffs(projects, {})).toEqual([]);
  });

  it("skips kickoff_in_progress projects that have a live council agent", () => {
    const projects = [makeProject("alpha", "kickoff_in_progress", oldTimestamp)];
    const registry: LiveAgentRegistry = {
      "council-kickoff-abc": {
        id: "council-kickoff-abc",
        role: "council",
        project_slug: "alpha",
        spawned_at: oldTimestamp,
        pid: 1234,
      },
    };
    expect(findStuckKickoffs(projects, registry)).toEqual([]);
  });

  it("skips projects updated within the grace period", () => {
    const projects = [makeProject("alpha", "kickoff_in_progress", freshTimestamp)];
    expect(findStuckKickoffs(projects, {})).toEqual([]);
  });

  it("does not match a council agent from a different project", () => {
    const projects = [makeProject("alpha", "kickoff_in_progress", oldTimestamp)];
    const registry: LiveAgentRegistry = {
      "council-kickoff-abc": {
        id: "council-kickoff-abc",
        role: "council",
        project_slug: "beta",
        spawned_at: oldTimestamp,
        pid: 1234,
      },
    };
    expect(findStuckKickoffs(projects, registry)).toEqual(["alpha"]);
  });

  it("does not match a non-council agent from the same project", () => {
    const projects = [makeProject("alpha", "kickoff_in_progress", oldTimestamp)];
    const registry: LiveAgentRegistry = {
      "crafter-abc": {
        id: "crafter-abc",
        role: "crafter",
        project_slug: "alpha",
        spawned_at: oldTimestamp,
        pid: 1234,
      },
    };
    expect(findStuckKickoffs(projects, registry)).toEqual(["alpha"]);
  });
});

// ── hasCompletedResearch ────────────────────────────────────────────────────

describe("hasCompletedResearch", () => {
  it("returns false when research_doc_refs is undefined", () => {
    const fm = { research_doc_refs: undefined } as unknown as import("./types/index.js").TaskFrontmatter;
    expect(hasCompletedResearch(fm)).toBe(false);
  });

  it("returns false when research_doc_refs is empty array", () => {
    const fm = { research_doc_refs: [] } as unknown as import("./types/index.js").TaskFrontmatter;
    expect(hasCompletedResearch(fm)).toBe(false);
  });

  it("returns false when research_doc_refs contains only empty string", () => {
    const fm = { research_doc_refs: [""] } as unknown as import("./types/index.js").TaskFrontmatter;
    expect(hasCompletedResearch(fm)).toBe(false);
  });

  it("returns false when research_doc_refs contains only whitespace", () => {
    const fm = { research_doc_refs: ["  "] } as unknown as import("./types/index.js").TaskFrontmatter;
    expect(hasCompletedResearch(fm)).toBe(false);
  });

  it("returns true when research_doc_refs has one valid path", () => {
    const fm = { research_doc_refs: ["state/knowledge/research/auth.md"] } as unknown as import("./types/index.js").TaskFrontmatter;
    expect(hasCompletedResearch(fm)).toBe(true);
  });

  it("returns true when research_doc_refs has mixed empty and valid entries", () => {
    const fm = { research_doc_refs: ["", "path/to/doc.md"] } as unknown as import("./types/index.js").TaskFrontmatter;
    expect(hasCompletedResearch(fm)).toBe(true);
  });
});
