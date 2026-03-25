import { describe, it, expect, vi, beforeEach } from "vitest";

const { files, normalize } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const normalize = (p: string): string => p.replace(/\\/g, "/");
  return { files, normalize };
});

vi.mock("../io/fileStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../io/fileStore.js")>();
  return {
    ...actual,
    readFile: vi.fn(async (p: string) => files.get(normalize(p)) ?? null),
    writeFile: vi.fn(async (p: string, c: string) => { files.set(normalize(p), c); }),
  };
});

import {
  writeProjectLearning,
  writeDriftLearning,
  writeGlobalLearning,
  readProjectKnowledge,
  readGlobalKnowledge,
} from "./councilLearning.js";
import type { LearningEntry, DriftLearning } from "./councilLearning.js";

beforeEach(() => {
  files.clear();
});

const baseLearning: LearningEntry = {
  timestamp: "2026-01-01T00:00:00.000Z",
  agent_id: "council-001",
  role: "council",
  task_id: "task-1",
  title: "Test Learning",
  content: "We learned something valuable.",
  tags: ["testing"],
};

const driftLearning: DriftLearning = {
  ...baseLearning,
  drift_score: 0.45,
  drift_cause: "Context overload",
  prevention_notes: "Shorter task scopes",
};

describe("writeProjectLearning", () => {
  it("writes to the correct project knowledge path", async () => {
    await writeProjectLearning("my-proj", "fullstack", baseLearning);
    const content = files.get(normalize("state/knowledge/projects/my-proj/fullstack/compound-learnings.md"));
    expect(content).toBeDefined();
    expect(content).toContain("Test Learning");
    expect(content).toContain("We learned something valuable.");
  });
});

describe("writeDriftLearning", () => {
  it("writes to both global and project paths", async () => {
    await writeDriftLearning("my-proj", "council", driftLearning);
    expect(files.get(normalize("state/knowledge/global/council/drift-patterns.md"))).toContain("Drift Event");
    expect(files.get(normalize("state/knowledge/projects/my-proj/council/drift-learnings.md"))).toContain("Context overload");
  });

  it("writes to global only when project is null", async () => {
    await writeDriftLearning(null, "steward", driftLearning);
    expect(files.get(normalize("state/knowledge/global/steward/drift-patterns.md"))).toBeDefined();
    const projectFiles = [...files.keys()].filter((k) => k.includes("state/knowledge/projects/"));
    expect(projectFiles.length).toBe(0);
  });
});

describe("writeGlobalLearning", () => {
  it("creates file with header when new", async () => {
    await writeGlobalLearning("council", "best-practices", baseLearning);
    const content = files.get(normalize("state/knowledge/global/council/best-practices.md"));
    expect(content).toBeDefined();
    expect(content).toMatch(/^# /);
    expect(content).toContain("Test Learning");
  });

  it("appends to existing file", async () => {
    files.set(normalize("state/knowledge/global/council/patterns.md"), "# Patterns\n\nExisting content.\n");
    await writeGlobalLearning("council", "patterns", baseLearning);
    const content = files.get(normalize("state/knowledge/global/council/patterns.md"))!;
    expect(content).toContain("Existing content.");
    expect(content).toContain("Test Learning");
  });
});

describe("readProjectKnowledge", () => {
  it("returns content for existing file", async () => {
    files.set(normalize("state/knowledge/projects/proj/fullstack/compound-learnings.md"), "# Learnings\n\nSome knowledge.");
    const content = await readProjectKnowledge("proj", "fullstack", "compound-learnings");
    expect(content).toContain("Some knowledge.");
  });

  it("returns null for missing file", async () => {
    expect(await readProjectKnowledge("proj", "fullstack", "nonexistent")).toBeNull();
  });
});

describe("readGlobalKnowledge", () => {
  it("returns content for existing file", async () => {
    files.set(normalize("state/knowledge/global/council/patterns.md"), "# Patterns\n\nGlobal knowledge.");
    expect(await readGlobalKnowledge("council", "patterns")).toContain("Global knowledge.");
  });

  it("returns null for missing file", async () => {
    expect(await readGlobalKnowledge("council", "missing")).toBeNull();
  });
});
