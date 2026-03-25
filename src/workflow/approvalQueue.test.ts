import { describe, it, expect, vi, beforeEach } from "vitest";

const { files, normalize } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const normalize = (p: string): string => p.replace(/\\/g, "/");
  return { files, normalize };
});

const mockReaddir = vi.hoisted(() => vi.fn<(dir: string) => Promise<string[]>>());
const mockRename = vi.hoisted(() => vi.fn<(from: string, to: string) => Promise<void>>());

vi.mock("fs", () => ({
  promises: {
    readdir: (...args: unknown[]) => mockReaddir(args[0] as string),
    rename: (...args: unknown[]) => mockRename(args[0] as string, args[1] as string),
    readFile: vi.fn().mockResolvedValue("{}"),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
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

import {
  createApproval,
  readApproval,
  updateApprovalStatus,
  listInboxItems,
} from "./approvalQueue.js";

beforeEach(() => {
  files.clear();
  mockReaddir.mockReset();
  mockRename.mockReset();
});

describe("createApproval", () => {
  it("writes approval markdown file and inbox notification", async () => {
    const result = await createApproval({
      type: "new_task",
      createdBy: "orchestrator",
      project: "test-project",
      councilRecommendation: "approve",
      relatedTaskRefs: [],
      body: "## Request\n\nPlease approve this task.",
    });

    expect(result.id).toMatch(/^approval-/);
    expect(normalize(result.filePath)).toContain("state/approvals/");

    const approvalContent = files.get(normalize(result.filePath));
    expect(approvalContent).toBeDefined();
    expect(approvalContent).toContain("new_task");

    const inboxFiles = [...files.keys()].filter((k) => k.includes("state/inbox/tarantoga/"));
    expect(inboxFiles.length).toBeGreaterThan(0);
  });

  it("writes to urgent/ dir when urgent: true", async () => {
    await createApproval({
      type: "task_cancellation",
      createdBy: "orchestrator",
      project: "test-project",
      councilRecommendation: "approve",
      relatedTaskRefs: [],
      body: "Urgent request",
      urgent: true,
    });

    const urgentFiles = [...files.keys()].filter((k) =>
      k.includes("state/inbox/tarantoga/urgent/"),
    );
    expect(urgentFiles.length).toBe(1);
  });

  it("generates unique IDs", async () => {
    const a = await createApproval({
      type: "new_task", createdBy: "orchestrator", project: null,
      councilRecommendation: "approve", relatedTaskRefs: [], body: "A",
    });
    const b = await createApproval({
      type: "new_task", createdBy: "orchestrator", project: null,
      councilRecommendation: "approve", relatedTaskRefs: [], body: "B",
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe("readApproval", () => {
  it("returns parsed frontmatter and body for existing approval", async () => {
    const { id } = await createApproval({
      type: "scope_change", createdBy: "council", project: "proj",
      councilRecommendation: "needs_research", relatedTaskRefs: ["task-1"],
      body: "## Scope Change\n\nDetails here.",
    });

    const result = await readApproval(id);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.type).toBe("scope_change");
    expect(result!.body).toContain("Scope Change");
  });

  it("returns null for missing approval", async () => {
    expect(await readApproval("approval-nonexistent")).toBeNull();
  });
});

describe("updateApprovalStatus", () => {
  it("merges partial updates into frontmatter", async () => {
    const { id } = await createApproval({
      type: "new_task", createdBy: "orchestrator", project: "proj",
      councilRecommendation: "approve", relatedTaskRefs: [], body: "Body",
    });

    await updateApprovalStatus(id, {
      status: "decided", decision: "approved", decision_rationale: "Looks good.",
    });

    const updated = await readApproval(id);
    expect(updated!.frontmatter.status).toBe("decided");
    expect(updated!.frontmatter.decision).toBe("approved");
    expect(updated!.frontmatter.decision_rationale).toBe("Looks good.");
  });

  it("throws for missing approval", async () => {
    await expect(
      updateApprovalStatus("approval-missing", { status: "decided" }),
    ).rejects.toThrow("Approval not found");
  });
});

describe("listInboxItems", () => {
  it("returns sorted items from folder", async () => {
    const item1 = JSON.stringify({
      id: "inbox-1", type: "approval_request", title: "First",
      summary: "...", created_at: "2026-01-02T00:00:00.000Z", priority: "normal",
    });
    const item2 = JSON.stringify({
      id: "inbox-2", type: "approval_request", title: "Second",
      summary: "...", created_at: "2026-01-01T00:00:00.000Z", priority: "normal",
    });

    mockReaddir.mockResolvedValue(["inbox-1.json", "inbox-2.json"]);
    files.set(normalize("state/inbox/tarantoga/unread/inbox-1.json"), item1);
    files.set(normalize("state/inbox/tarantoga/unread/inbox-2.json"), item2);

    const items = await listInboxItems("unread");
    expect(items.length).toBe(2);
    expect(items[0]!.id).toBe("inbox-2");
    expect(items[1]!.id).toBe("inbox-1");
  });

  it("skips malformed JSON files", async () => {
    mockReaddir.mockResolvedValue(["bad.json", "good.json"]);
    files.set(normalize("state/inbox/tarantoga/unread/bad.json"), "not valid json{{{");
    files.set(normalize("state/inbox/tarantoga/unread/good.json"), JSON.stringify({
      id: "good", type: "approval_request", title: "Good",
      summary: "...", created_at: "2026-01-01T00:00:00.000Z", priority: "normal",
    }));

    const items = await listInboxItems("unread");
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe("good");
  });

  it("returns empty array for missing folder", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await listInboxItems("unread")).toEqual([]);
  });
});
