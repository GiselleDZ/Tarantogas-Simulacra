import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentContext } from "../types/index.js";

const mockSpawnAgent = vi.hoisted(() => vi.fn());

vi.mock("./spawner.js", () => ({
  spawnAgent: mockSpawnAgent,
  readRegistry: vi.fn().mockResolvedValue({}),
  deregisterAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../io/fileStore.js", () => ({
  readFile: vi.fn().mockResolvedValue(null),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readMarkdownFile: vi.fn().mockResolvedValue(null),
  writeMarkdownFile: vi.fn().mockResolvedValue(undefined),
  appendLine: vi.fn().mockResolvedValue(undefined),
  parseFrontmatter: vi.fn().mockReturnValue(null),
  serializeFrontmatter: vi.fn().mockReturnValue(""),
}));

vi.mock("../io/lock.js", () => ({
  FileLock: vi.fn().mockImplementation(() => ({
    withLock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    acquire: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../io/logger.js", () => ({
  logEvent: vi.fn(),
}));

import {
  spawnCouncilForKickoff,
  spawnCouncilForCompound,
  spawnCouncilForReview,
  spawnCouncilForPeerReview,
  spawnCouncilForResearchReview,
} from "./council.js";
import { spawnCrafter, spawnCrafterForRevision } from "./crafter.js";
import { spawnStewardForReview, spawnStewardForFinalSignOff } from "./steward.js";

const baseDeps = {
  rolesConfig: {
    roles: {
      council: { permitted_mcps: [], check_interval_tool_uses: 100 },
      crafter: { permitted_mcps: [], check_interval_tool_uses: 50 },
      steward: { permitted_mcps: [], check_interval_tool_uses: 100 },
      research: { permitted_mcps: [], check_interval_tool_uses: 100 },
    },
    crafter_types: {},
  },
  simulacraConfig: {
    mcp_servers: {},
    paths: { roles_dir: "roles" },
  },
};

beforeEach(() => {
  mockSpawnAgent.mockReset();
  mockSpawnAgent.mockResolvedValue({
    identity: { id: "mock", role: "council", spawned_at: "", pid: 1 },
    process: {},
  });
});

function lastContext(): AgentContext {
  expect(mockSpawnAgent).toHaveBeenCalled();
  const lastCall = mockSpawnAgent.mock.calls[mockSpawnAgent.mock.calls.length - 1];
  return lastCall[0] as AgentContext;
}

describe("Council spawn helpers", () => {
  it("spawnCouncilForKickoff sets phase: kickoff and no task_file_path", async () => {
    await spawnCouncilForKickoff("proj", "/path", "council-k1", baseDeps, async () => undefined);
    const ctx = lastContext();
    expect(ctx.phase).toBe("kickoff");
    expect(ctx.role).toBe("council");
    expect(ctx.task_file_path).toBeUndefined();
    expect(ctx.agent_id).toBe("council-k1");
  });

  it("spawnCouncilForCompound sets phase: compound", async () => {
    await spawnCouncilForCompound("task.md", "proj", "/path", "council-c1", baseDeps, async () => undefined);
    const ctx = lastContext();
    expect(ctx.phase).toBe("compound");
    expect(ctx.task_file_path).toBe("task.md");
  });

  it("spawnCouncilForReview sets phase: council-review", async () => {
    await spawnCouncilForReview("task.md", "proj", "/path", "council-r1", baseDeps, async () => undefined);
    expect(lastContext().phase).toBe("council-review");
  });

  it("spawnCouncilForPeerReview sets phase: peer-review", async () => {
    await spawnCouncilForPeerReview("task.md", "proj", "/path", "council-p1", baseDeps, async () => undefined);
    expect(lastContext().phase).toBe("peer-review");
  });

  it("spawnCouncilForResearchReview sets phase: research-review", async () => {
    await spawnCouncilForResearchReview("task.md", "proj", "/path", "council-rr1", baseDeps, async () => undefined);
    expect(lastContext().phase).toBe("research-review");
  });
});

describe("Crafter spawn helpers", () => {
  it("spawnCrafter sets phase: work and project_path", async () => {
    await spawnCrafter("task.md", "proj", "/my/project", "fullstack", "crafter-1", baseDeps, async () => undefined);
    const ctx = lastContext();
    expect(ctx.phase).toBe("work");
    expect(ctx.role).toBe("crafter");
    expect(ctx.project_path).toBe("/my/project");
  });

  it("spawnCrafterForRevision sets phase: revision", async () => {
    await spawnCrafterForRevision("task.md", "proj", "/path", "fullstack", "crafter-r1", baseDeps, async () => undefined);
    expect(lastContext().phase).toBe("revision");
  });
});

describe("Steward spawn helpers", () => {
  it("spawnStewardForReview sets phase: review", async () => {
    await spawnStewardForReview("task.md", "proj", "/path", "steward-1", baseDeps, async () => undefined);
    const ctx = lastContext();
    expect(ctx.phase).toBe("review");
    expect(ctx.role).toBe("steward");
  });

  it("spawnStewardForFinalSignOff sets phase: final", async () => {
    await spawnStewardForFinalSignOff("task.md", "proj", "/path", "crafter-1", "steward-f1", baseDeps, async () => undefined);
    const ctx = lastContext();
    expect(ctx.phase).toBe("final");
    expect(ctx.extra_context).toBeDefined();
  });
});
