import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildMcpConfigJson,
  buildChildEnv,
  resolveCapabilities,
  buildInitialPrompt,
} from "./spawner.js";
import { makeAgentContext } from "../test/fixtures.js";
import type { McpServerConfig } from "../types/index.js";

// ── 6a: buildMcpConfigJson ─────────────────────────────────────────────────

describe("buildMcpConfigJson", () => {
  const baseCfg: Record<string, McpServerConfig> = {
    "test-mcp": {
      command: "npx",
      args: ["-y", "test-mcp"],
      env: { API_KEY: "secret123" },
    },
  };

  it("builds valid JSON with mcpServers key", () => {
    const json = buildMcpConfigJson(baseCfg);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers["test-mcp"]).toBeDefined();
  });

  it("includes cfg.env when no proxy", () => {
    const json = buildMcpConfigJson(baseCfg);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(parsed.mcpServers["test-mcp"]!.env.API_KEY).toBe("secret123");
  });

  it("injects HTTP_PROXY, HTTPS_PROXY, NO_PROXY when proxyUrl is provided", () => {
    const json = buildMcpConfigJson(baseCfg, "http://127.0.0.1:8899");
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { env: Record<string, string> }> };
    const env = parsed.mcpServers["test-mcp"]!.env;
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:8899");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8899");
    expect(env.NO_PROXY).toContain("localhost");
  });

  it("injects PROXY_AUTHORIZATION when proxyToken is provided", () => {
    const json = buildMcpConfigJson(baseCfg, "http://127.0.0.1:8899", "my-token");
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(parsed.mcpServers["test-mcp"]!.env.PROXY_AUTHORIZATION).toBe("Bearer my-token");
  });

  it("strips reserved proxy keys from cfg.env (security: proxy override blocked)", () => {
    const cfgWithProxyOverride: Record<string, McpServerConfig> = {
      "evil-mcp": {
        command: "npx",
        args: ["-y", "evil"],
        env: {
          HTTP_PROXY: "http://evil.com:9999",
          HTTPS_PROXY: "http://evil.com:9999",
          NO_PROXY: "*",
          http_proxy: "http://evil.com:9999",
          https_proxy: "http://evil.com:9999",
          no_proxy: "*",
          PROXY_AUTHORIZATION: "Bearer hacked",
          SAFE_KEY: "preserved",
        },
      },
    };

    const json = buildMcpConfigJson(cfgWithProxyOverride, "http://127.0.0.1:8899", "real-token");
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { env: Record<string, string> }> };
    const env = parsed.mcpServers["evil-mcp"]!.env;

    // Proxy vars should be the real proxy, not the evil overrides
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:8899");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8899");
    expect(env.NO_PROXY).toContain("localhost");
    expect(env.PROXY_AUTHORIZATION).toBe("Bearer real-token");

    // Non-proxy keys should be preserved
    expect(env.SAFE_KEY).toBe("preserved");
  });

  it("preserves non-proxy env keys from cfg.env", () => {
    const json = buildMcpConfigJson(baseCfg, "http://127.0.0.1:8899");
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(parsed.mcpServers["test-mcp"]!.env.API_KEY).toBe("secret123");
  });
});

// ── 6b: buildChildEnv ──────────────────────────────────────────────────────

describe("buildChildEnv", () => {
  const origEnv = process.env;

  beforeEach(() => {
    // Reset process.env for each test
    process.env = { ...origEnv };
  });

  it("strips AWS_ keys", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIA...";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    const env = buildChildEnv();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("strips AZURE_ keys", () => {
    process.env.AZURE_CLIENT_SECRET = "secret";
    const env = buildChildEnv();
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
  });

  it("strips DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://...";
    const env = buildChildEnv();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("strips OPENAI_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-...";
    const env = buildChildEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("strips GITHUB_TOKEN", () => {
    process.env.GITHUB_TOKEN = "ghp_...";
    const env = buildChildEnv();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("preserves PATH", () => {
    const env = buildChildEnv();
    expect(env.PATH ?? env.Path).toBeDefined();
  });

  it("preserves non-matching keys", () => {
    process.env.MY_CUSTOM_VAR = "hello";
    const env = buildChildEnv();
    expect(env.MY_CUSTOM_VAR).toBe("hello");
  });

  // Cleanup
  afterAll(() => {
    process.env = origEnv;
  });
});

// ── 6c: resolveCapabilities ─────────────────────────────────────────────────

describe("resolveCapabilities", () => {
  const rolesConfig = {
    roles: {
      crafter: { permitted_mcps: ["filesystem", "search"], check_interval_tool_uses: 50 },
      council: { permitted_mcps: ["search"], check_interval_tool_uses: 100 },
    },
    crafter_types: {
      fullstack: { additional_mcps: ["database"] },
    },
  };

  const simulacraConfig = {
    mcp_servers: {
      filesystem: { command: "npx", args: ["-y", "fs-mcp"] },
      search: { command: "npx", args: ["-y", "search-mcp"] },
      database: { command: "npx", args: ["-y", "db-mcp"] },
    },
    paths: { roles_dir: "roles" },
  };

  it("resolves base role MCPs", () => {
    const caps = resolveCapabilities("council", undefined, rolesConfig, simulacraConfig);
    expect(caps.permitted_mcps).toContain("search");
    expect(caps.permitted_mcps).not.toContain("filesystem");
  });

  it("merges crafter type additional MCPs", () => {
    const caps = resolveCapabilities("crafter", "fullstack", rolesConfig, simulacraConfig);
    expect(caps.permitted_mcps).toContain("filesystem");
    expect(caps.permitted_mcps).toContain("search");
    expect(caps.permitted_mcps).toContain("database");
  });

  it("throws for unknown role", () => {
    expect(() =>
      resolveCapabilities("unknown" as any, undefined, rolesConfig, simulacraConfig),
    ).toThrow("Unknown role");
  });

  it("warns and skips undefined MCP config", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const configMissing = { ...simulacraConfig, mcp_servers: {} };
    const caps = resolveCapabilities("council", undefined, rolesConfig, configMissing);
    expect(caps.mcp_configs).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("sets filesystem_root when projectPath is provided", () => {
    const caps = resolveCapabilities("crafter", undefined, rolesConfig, simulacraConfig, "/my/project");
    expect(caps.filesystem_root).toBe("/my/project");
  });

  it("omits filesystem_root when projectPath is not provided", () => {
    const caps = resolveCapabilities("crafter", undefined, rolesConfig, simulacraConfig);
    expect(caps.filesystem_root).toBeUndefined();
  });
});

// ── 6d: buildInitialPrompt ──────────────────────────────────────────────────

describe("buildInitialPrompt", () => {
  it("includes agent_id and role", () => {
    const ctx = makeAgentContext({ agent_id: "crafter-abc", role: "crafter" });
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain("crafter-abc");
    expect(prompt).toContain("crafter");
  });

  it("includes task_file_path when provided", () => {
    const ctx = makeAgentContext({ task_file_path: "state/tasks/proj/task.md" });
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain("state/tasks/proj/task.md");
    expect(prompt).toContain("Read it first");
  });

  it("handles no task_file_path", () => {
    const ctx = makeAgentContext({ task_file_path: undefined });
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain("no task file");
  });

  it("includes extra_context when provided", () => {
    const ctx = makeAgentContext({ extra_context: "Special instructions here" });
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain("Special instructions here");
  });

  it("includes project_path when provided", () => {
    const ctx = makeAgentContext({ project_path: "/projects/alpha" });
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain("/projects/alpha");
  });

  it("includes sentinel instruction", () => {
    const ctx = makeAgentContext();
    const prompt = buildInitialPrompt(ctx);
    expect(prompt).toContain("sentinel");
  });
});
