import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTaskFrontmatter } from "../test/fixtures.js";
import { serializeFrontmatter } from "../io/fileStore.js";

const { files, normalize } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const normalize = (p: string): string => p.replace(/\\/g, "/");
  return { files, normalize };
});

const mockReaddir = vi.hoisted(() => vi.fn<(path: string) => Promise<string[]>>());

vi.mock("fs", () => ({
  promises: {
    readdir: (...args: unknown[]) => mockReaddir(args[0] as string),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../io/fileStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../io/fileStore.js")>();
  return {
    ...actual,
    readFile: vi.fn(async (p: string) => files.get(normalize(p)) ?? null),
    writeFile: vi.fn(async (p: string, c: string) => { files.set(normalize(p), c); }),
    readMarkdownFile: vi.fn(async <T extends object>(p: string) => {
      const raw = files.get(normalize(p));
      if (raw === undefined) return null;
      const parsed = actual.parseFrontmatter<T>(raw);
      if (parsed === null) return null;
      return { ...parsed, rawContent: raw };
    }),
    writeMarkdownFile: vi.fn(async (p: string, fm: object, body: string) => {
      files.set(normalize(p), actual.serializeFrontmatter(fm, body));
    }),
  };
});

import { activateKickoffTasks, cancelKickoffTasks } from "./taskCreation.js";

beforeEach(() => {
  files.clear();
  mockReaddir.mockReset();
});

function seedTask(slug: string, filename: string, id: string, status = "blocked"): void {
  const fm = makeTaskFrontmatter({ id, status: status as any, project: slug });
  files.set(normalize(`state/tasks/${slug}/${filename}`), serializeFrontmatter(fm, ""));
  mockReaddir.mockResolvedValue([filename]);
}

describe("activateKickoffTasks", () => {
  it("sets blocked tasks to pending", async () => {
    seedTask("proj", "task-a.md", "task-a", "blocked");
    await activateKickoffTasks("proj", ["task-a"]);
    const content = files.get(normalize("state/tasks/proj/task-a.md"));
    expect(content).toContain("pending");
  });

  it("logs warning for missing task and continues", async () => {
    mockReaddir.mockResolvedValue([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await activateKickoffTasks("proj", ["nonexistent-task"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Task not found"));
    warnSpy.mockRestore();
  });
});

describe("cancelKickoffTasks", () => {
  it("sets tasks to cancelled", async () => {
    seedTask("proj", "task-b.md", "task-b", "blocked");
    await cancelKickoffTasks("proj", ["task-b"]);
    const content = files.get(normalize("state/tasks/proj/task-b.md"));
    expect(content).toContain("cancelled");
  });

  it("handles empty taskIds gracefully", async () => {
    await expect(cancelKickoffTasks("proj", [])).resolves.toBeUndefined();
  });
});
