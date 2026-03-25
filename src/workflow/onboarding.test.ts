import { describe, it, expect, vi, beforeEach } from "vitest";

const { files, normalize } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const normalize = (p: string): string => p.replace(/\\/g, "/");
  return { files, normalize };
});

const mockMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(async (path: string) => {
      const content = files.get(normalize(path));
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return content;
    }),
    writeFile: vi.fn(),
    mkdir: mockMkdir,
    rename: vi.fn(),
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

vi.mock("./approvalQueue.js", () => ({
  createApproval: vi.fn().mockResolvedValue({
    id: "approval-mock-001",
    filePath: "state/approvals/approval-mock-001.md",
  }),
}));

import {
  onboardProject,
  activateProject,
  setProjectStatus,
  listProjects,
  getProject,
} from "./onboarding.js";

beforeEach(() => {
  files.clear();
  mockMkdir.mockReset().mockResolvedValue(undefined);
});

function seedRegistry(entries: Record<string, object>): void {
  files.set(normalize("state/projects/registry.json"), JSON.stringify(entries));
}

describe("onboardProject", () => {
  it("creates registry entry and returns slug + approvalId", async () => {
    seedRegistry({});
    const result = await onboardProject({
      name: "My Cool Project",
      path: "/projects/cool",
      crafterTypes: ["fullstack"],
      requestedBy: "tarantoga",
    });

    expect(result.slug).toBe("my-cool-project");
    expect(result.approvalId).toBe("approval-mock-001");

    const registry = JSON.parse(files.get(normalize("state/projects/registry.json"))!);
    expect(registry["my-cool-project"]).toBeDefined();
    expect(registry["my-cool-project"].status).toBe("onboarding_requested");
  });

  it("generates correct slug from name", async () => {
    seedRegistry({});
    const result = await onboardProject({
      name: "Test--Project!!  123",
      path: "/test",
      crafterTypes: [],
      requestedBy: "test",
    });
    expect(result.slug).toBe("test-project-123");
  });
});

describe("activateProject", () => {
  it("sets status to kickoff_pending", async () => {
    seedRegistry({
      "test-proj": {
        slug: "test-proj", name: "Test", path: "/test",
        status: "onboarding_requested",
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
        crafter_types: ["fullstack"], active_task_ids: [],
      },
    });

    await activateProject("test-proj");
    const registry = JSON.parse(files.get(normalize("state/projects/registry.json"))!);
    expect(registry["test-proj"].status).toBe("kickoff_pending");
  });

  it("creates task and knowledge directories", async () => {
    seedRegistry({
      "test-proj": {
        slug: "test-proj", name: "Test", path: "/test",
        status: "onboarding_requested",
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
        crafter_types: ["fullstack", "backend"], active_task_ids: [],
      },
    });

    await activateProject("test-proj");
    expect(mockMkdir).toHaveBeenCalledWith("state/tasks/test-proj", { recursive: true });
    expect(mockMkdir).toHaveBeenCalledWith("state/knowledge/projects/test-proj", { recursive: true });
  });

  it("throws for unknown slug", async () => {
    seedRegistry({});
    await expect(activateProject("nonexistent")).rejects.toThrow("Project not found");
  });
});

describe("setProjectStatus", () => {
  it("updates the project status in registry", async () => {
    seedRegistry({
      "proj": {
        slug: "proj", name: "P", path: "/p", status: "active",
        created_at: "", updated_at: "", crafter_types: [], active_task_ids: [],
      },
    });

    await setProjectStatus("proj", "archived");
    const registry = JSON.parse(files.get(normalize("state/projects/registry.json"))!);
    expect(registry["proj"].status).toBe("archived");
  });

  it("throws for unknown slug", async () => {
    seedRegistry({});
    await expect(setProjectStatus("nope", "active")).rejects.toThrow("Project not found");
  });
});

describe("listProjects", () => {
  beforeEach(() => {
    seedRegistry({
      "a": { slug: "a", name: "A", path: "/a", status: "active", created_at: "", updated_at: "", crafter_types: [], active_task_ids: [] },
      "b": { slug: "b", name: "B", path: "/b", status: "archived", created_at: "", updated_at: "", crafter_types: [], active_task_ids: [] },
      "c": { slug: "c", name: "C", path: "/c", status: "active", created_at: "", updated_at: "", crafter_types: [], active_task_ids: [] },
    });
  });

  it("returns all projects without filter", async () => {
    expect((await listProjects()).length).toBe(3);
  });

  it("filters by status", async () => {
    const active = await listProjects("active");
    expect(active.length).toBe(2);
    expect(active.every((p) => p.status === "active")).toBe(true);
  });
});

describe("getProject", () => {
  it("returns project for existing slug", async () => {
    seedRegistry({
      "proj": { slug: "proj", name: "P", path: "/p", status: "active", created_at: "", updated_at: "", crafter_types: [], active_task_ids: [] },
    });
    const result = await getProject("proj");
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("proj");
  });

  it("returns null for missing slug", async () => {
    seedRegistry({});
    expect(await getProject("missing")).toBeNull();
  });
});
