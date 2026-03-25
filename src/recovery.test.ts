import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { makeTaskFrontmatter, makeAgentIdentity } from "./test/fixtures.js";
import { serializeFrontmatter } from "./io/fileStore.js";

// vi.hoisted creates variables accessible inside vi.mock factories
const { files, normalize } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const normalize = (p: string): string => p.replace(/\\/g, "/");
  return { files, normalize };
});

vi.mock("./io/fileStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./io/fileStore.js")>();
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

const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

import { recoverCrashedAgents } from "./recovery.js";

beforeEach(() => {
  files.clear();
  killSpy.mockReset();
});

function seedRegistry(agents: Record<string, ReturnType<typeof makeAgentIdentity>>): void {
  files.set(normalize("state/agents/live.json"), JSON.stringify(agents));
}

function seedTask(
  filePath: string,
  overrides: Partial<ReturnType<typeof makeTaskFrontmatter>>,
  body = "",
): void {
  const fm = makeTaskFrontmatter(overrides);
  files.set(normalize(filePath), serializeFrontmatter(fm, body));
}

describe("recoverCrashedAgents", () => {
  it("returns empty array when no registry file exists", async () => {
    const crashed = await recoverCrashedAgents();
    expect(crashed).toEqual([]);
  });

  it("returns empty array when all agents are alive", async () => {
    killSpy.mockImplementation(() => true);
    const agent = makeAgentIdentity({ id: "agent-1", pid: 9999 });
    seedRegistry({ "agent-1": agent });
    const crashed = await recoverCrashedAgents();
    expect(crashed).toEqual([]);
  });

  it("detects crashed crafter (in_progress) and resets task to pending", async () => {
    killSpy.mockImplementation(() => { throw new Error("no such process"); });
    const agent = makeAgentIdentity({
      id: "crafter-1", role: "crafter", pid: 9999,
      task_id: "state/tasks/proj/task.md",
    });
    seedRegistry({ "crafter-1": agent });
    seedTask("state/tasks/proj/task.md", {
      status: "in_progress", assigned_crafter: "crafter-1",
    });

    const crashed = await recoverCrashedAgents();
    expect(crashed).toContain("crafter-1");
    const taskContent = files.get(normalize("state/tasks/proj/task.md"));
    expect(taskContent).toContain("pending");
  });

  it("preserves steward_review status and nulls assigned_steward", async () => {
    killSpy.mockImplementation(() => { throw new Error("no such process"); });
    const agent = makeAgentIdentity({
      id: "steward-1", role: "steward", pid: 7777,
      task_id: "state/tasks/proj/t3.md",
    });
    seedRegistry({ "steward-1": agent });
    seedTask("state/tasks/proj/t3.md", {
      status: "steward_review", assigned_steward: "steward-1",
    });

    await recoverCrashedAgents();
    const content = files.get(normalize("state/tasks/proj/t3.md"))!;
    expect(content).toContain("steward_review");
    expect(content).toContain("assigned_steward: null");
  });

  it("preserves council_review status and nulls assigned_council_author", async () => {
    killSpy.mockImplementation(() => { throw new Error("no such process"); });
    const agent = makeAgentIdentity({
      id: "council-1", role: "council", pid: 6666,
      task_id: "state/tasks/proj/t4.md",
    });
    seedRegistry({ "council-1": agent });
    seedTask("state/tasks/proj/t4.md", {
      status: "council_review", assigned_council_author: "council-1",
    });

    await recoverCrashedAgents();
    const content = files.get(normalize("state/tasks/proj/t4.md"))!;
    expect(content).toContain("council_review");
    expect(content).toContain("assigned_council_author: null");
  });

  it("rebuilds registry with survivors only", async () => {
    killSpy.mockImplementation(((pid: number) => {
      if (pid === 1111) return true;
      throw new Error("no such process");
    }) as any);

    const alive = makeAgentIdentity({ id: "alive-1", pid: 1111 });
    const dead = makeAgentIdentity({ id: "dead-1", pid: 2222, task_id: undefined });
    seedRegistry({ "alive-1": alive, "dead-1": dead });

    await recoverCrashedAgents();
    const registry = JSON.parse(files.get(normalize("state/agents/live.json"))!) as Record<string, unknown>;
    expect(registry["alive-1"]).toBeDefined();
    expect(registry["dead-1"]).toBeUndefined();
  });

  it("writes crash notification to inbox", async () => {
    killSpy.mockImplementation(() => { throw new Error("no such process"); });
    const agent = makeAgentIdentity({ id: "dead-agent", pid: 5555, task_id: undefined });
    seedRegistry({ "dead-agent": agent });

    await recoverCrashedAgents();
    const inboxFiles = [...files.keys()].filter((k) =>
      k.includes("state/inbox/tarantoga/unread/crash-recovery"),
    );
    expect(inboxFiles.length).toBe(1);
    expect(files.get(inboxFiles[0]!)).toContain("dead-agent");
  });

  it("scrubs sentinels from task body", async () => {
    killSpy.mockImplementation(() => { throw new Error("no such process"); });
    const agent = makeAgentIdentity({
      id: "crafter-s", role: "crafter", pid: 4444,
      task_id: "state/tasks/proj/scrub.md",
    });
    seedRegistry({ "crafter-s": agent });
    seedTask(
      "state/tasks/proj/scrub.md",
      { status: "in_progress", assigned_crafter: "crafter-s" },
      "## Crafter Work\n\nSTATUS_SIGNAL: ready_for_steward_review\n",
    );

    await recoverCrashedAgents();
    const content = files.get(normalize("state/tasks/proj/scrub.md"))!;
    expect(content).not.toContain("STATUS_SIGNAL: ready_for_steward_review");
    expect(content).toContain("[sentinel cleared]");
  });

  it("appends recovery note to task body", async () => {
    killSpy.mockImplementation(() => { throw new Error("no such process"); });
    const agent = makeAgentIdentity({
      id: "crafter-n", role: "crafter", pid: 3333,
      task_id: "state/tasks/proj/note.md",
    });
    seedRegistry({ "crafter-n": agent });
    seedTask("state/tasks/proj/note.md", {
      status: "in_progress", assigned_crafter: "crafter-n",
    });

    await recoverCrashedAgents();
    const content = files.get(normalize("state/tasks/proj/note.md"))!;
    expect(content).toContain("## Recovery Note");
    expect(content).toContain("crafter-n");
  });
});
