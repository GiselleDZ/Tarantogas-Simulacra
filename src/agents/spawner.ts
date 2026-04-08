import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { promises as fs } from "fs";
import { writeFile, readFile, appendLine } from "../io/fileStore.js";
import { FileLock } from "../io/lock.js";
import { logEvent } from "../io/logger.js";
import type {
  AgentRole,
  AgentIdentity,
  AgentCapabilities,
  AgentContext,
  AgentResult,
  AgentCostEntry,
  LiveAgentRegistry,
  McpServerConfig,
} from "../types/index.js";

const REGISTRY_PATH = "state/agents/live.json";
const registryLock = new FileLock(REGISTRY_PATH);

interface RolesConfig {
  readonly roles: Record<
    string,
    {
      readonly permitted_mcps: readonly string[];
      readonly check_interval_tool_uses: number;
      readonly baseline_traits?: readonly string[];
    }
  >;
  readonly crafter_types: Record<
    string,
    { readonly additional_mcps: readonly string[] }
  >;
}

interface SimulacraConfig {
  readonly mcp_servers: Record<string, McpServerConfig>;
  readonly paths: { readonly roles_dir: string };
  readonly orchestrator?: { readonly agent_timeout_ms?: number };
  readonly mcp_proxy?: { readonly enabled: boolean; readonly port?: number; readonly allowlist?: readonly string[] };
}

/** Read the live agent registry, returning an empty registry on ENOENT. */
async function readRegistry(): Promise<LiveAgentRegistry> {
  const raw = await readFile(REGISTRY_PATH);
  if (raw === null) return {};
  return JSON.parse(raw) as LiveAgentRegistry;
}

/** Atomically update the live registry with a single agent entry. */
async function registerAgent(identity: AgentIdentity): Promise<void> {
  await registryLock.withLock(async () => {
    const registry = await readRegistry();
    const updated: LiveAgentRegistry = { ...registry, [identity.id]: identity };
    await writeFile(REGISTRY_PATH, JSON.stringify(updated, null, 2));
  });
}

/** Remove an agent from the live registry after it exits. */
async function deregisterAgent(agentId: string): Promise<void> {
  await registryLock.withLock(async () => {
    const registry = await readRegistry();
    const { [agentId]: _removed, ...remaining } = registry;
    await writeFile(REGISTRY_PATH, JSON.stringify(remaining, null, 2));
  });
}

/** Resolve the permitted MCP list and configs for a given role. */
export function resolveCapabilities(
  role: AgentRole,
  crafterType: string | undefined,
  rolesConfig: RolesConfig,
  simulacraConfig: SimulacraConfig,
  projectPath?: string,
): AgentCapabilities {
  const roleDef = rolesConfig.roles[role];
  if (roleDef === undefined) {
    throw new Error(`Unknown role: ${role}`);
  }

  const permittedSet = new Set<string>(roleDef.permitted_mcps);

  if (role === "crafter" && crafterType !== undefined) {
    const crafterTypeDef = rolesConfig.crafter_types[crafterType];
    if (crafterTypeDef !== undefined) {
      for (const mcp of crafterTypeDef.additional_mcps) {
        permittedSet.add(mcp);
      }
    }
  }

  const mcp_configs: Record<string, McpServerConfig> = {};
  for (const name of permittedSet) {
    const cfg = simulacraConfig.mcp_servers[name];
    if (cfg === undefined) {
      console.warn(`[Spawner] MCP '${name}' permitted for role '${role}' but not defined in simulacra.yaml`);
      continue;
    }
    mcp_configs[name] = cfg;
  }

  const base = {
    permitted_mcps: [...permittedSet],
    mcp_configs,
  };
  return projectPath !== undefined
    ? { ...base, filesystem_root: projectPath }
    : base;
}

/**
 * Build the MCP config JSON string for --mcp-config.
 * Claude Code expects: {"mcpServers":{"name":{"command":"...","args":[...]}}}
 *
 * When proxyUrl is provided, HTTP_PROXY / HTTPS_PROXY are merged into each
 * MCP server's env so their outbound requests are gated through the proxy.
 */
/** Proxy env var keys that MCP server configs must not override. */
const RESERVED_PROXY_KEYS = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "PROXY_AUTHORIZATION",
]);

export function buildMcpConfigJson(
  mcpConfigs: Record<string, McpServerConfig>,
  proxyUrl?: string,
  proxyToken?: string,
): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(mcpConfigs)) {
    const proxyEnv: Record<string, string> = proxyUrl !== undefined
      ? {
          HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: "localhost,127.0.0.1,::1",
          ...(proxyToken !== undefined ? { PROXY_AUTHORIZATION: `Bearer ${proxyToken}` } : {}),
        }
      : {};

    // Strip reserved proxy keys from the MCP server config env so they cannot
    // override proxy routing — proxy vars always win.
    const sanitizedCfgEnv: Record<string, string> = {};
    if (cfg.env !== undefined) {
      for (const [key, val] of Object.entries(cfg.env)) {
        if (!RESERVED_PROXY_KEYS.has(key)) {
          sanitizedCfgEnv[key] = val;
        }
      }
    }

    const mergedEnv = cfg.env !== undefined || proxyUrl !== undefined
      ? { ...sanitizedCfgEnv, ...proxyEnv }
      : undefined;
    mcpServers[name] = {
      command: cfg.command,
      args: [...cfg.args],
      ...(mergedEnv !== undefined ? { env: mergedEnv } : {}),
    };
  }
  return JSON.stringify({ mcpServers });
}

/**
 * Build the initial prompt that tells the agent what to do.
 * Since we use --print (non-interactive), this is the agent's entry point.
 */
export function buildInitialPrompt(context: AgentContext): string {
  const lines: string[] = [
    `You are agent ${context.agent_id}, role: ${context.role}.`,
  ];

  if (context.task_file_path !== undefined) {
    lines.push(
      `Your task file is at: ${context.task_file_path}`,
      `Read it first with the Read tool, then carry out the work described.`,
    );
  } else {
    lines.push(`You have no task file — your entry point is in the extra context below.`);
  }

  if (context.project_path !== undefined) {
    lines.push(`Your project directory is: ${context.project_path}`);
  }

  if (context.extra_context !== undefined) {
    lines.push("", context.extra_context);
  }

  lines.push(
    "",
    "Follow all instructions in your CLAUDE.md role file.",
    "When your work is complete, write the appropriate sentinel signal to your section of the task file.",
  );

  return lines.join("\n");
}

/**
 * Known credential environment variable patterns to strip from the child process env.
 * Uses a blocklist rather than an allowlist to preserve Windows-required vars
 * (USERPROFILE, APPDATA, LOCALAPPDATA, SystemRoot, ComSpec, etc.) while
 * preventing credential leakage to spawned Claude agents.
 */
const BLOCKED_ENV_PATTERNS: readonly RegExp[] = [
  /^AWS_/,
  /^AZURE_/,
  /^GOOGLE_/,
  /^GCLOUD_/,
  /^GH_TOKEN$/,
  /^GITHUB_TOKEN$/,
  /^GITHUB_APP_PRIVATE_KEY$/,
  /^GITLAB_TOKEN$/,
  /^SSH_AUTH_SOCK$/,
  /^VAULT_TOKEN$/,
  /^NPM_TOKEN$/,
  /^DOCKER_AUTH_CONFIG$/,
  /^KUBECONFIG$/,
  /^DATABASE_URL$/,
  /^POSTGRES_/,
  /^MYSQL_/,
  /^MONGO_/,
  /^REDIS_URL$/,
  /^REDIS_PASSWORD$/,
  /^OPENAI_API_KEY$/,
  /^COHERE_API_KEY$/,
  /^MISTRAL_API_KEY$/,
];

export function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (BLOCKED_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Build the verified `claude` CLI arguments for this agent spawn.
 * All flags here are confirmed against `claude --help`.
 */
async function buildClaudeArgs(
  context: AgentContext,
  capabilities: AgentCapabilities,
  rolesDir: string,
  proxyUrl?: string,
  proxyToken?: string,
): Promise<{ args: readonly string[]; prompt: string }> {
  const args: string[] = [
    // Non-interactive agentic mode — agent runs, uses tools, exits
    "--print",
    // Agents must edit files and run commands without human approval prompts
    "--permission-mode", "bypassPermissions",
    // Output format for machine-readable parsing
    "--output-format", "json",
  ];

  // ── Phase-scoped role prompt ────────────────────────────────────────────────
  // Try roles/{role}/phases/{phase}.md first — only injects the relevant portion
  // of the role CLAUDE.md for the current pipeline phase (leaner context).
  // Falls back to the full roles/{role}/CLAUDE.md if no phase file is found.
  const SAFE_PHASE = /^[a-zA-Z0-9_-]{1,64}$/;
  let roleMdContent: string | null = null;
  if (context.phase !== undefined && SAFE_PHASE.test(context.phase)) {
    const phaseMdPath = path.resolve(rolesDir, context.role, "phases", `${context.phase}.md`);
    const allowedBase = path.resolve(rolesDir, context.role, "phases");
    if (phaseMdPath.startsWith(allowedBase + path.sep)) {
      roleMdContent = await readFile(phaseMdPath);
    }
  }
  if (roleMdContent === null) {
    roleMdContent = await readFile(path.join(rolesDir, context.role, "CLAUDE.md"));
  }
  if (roleMdContent !== null) {
    args.push("--append-system-prompt", roleMdContent);
  }

  // MCP servers for this role, optionally routed through the egress proxy
  if (Object.keys(capabilities.mcp_configs).length > 0) {
    args.push("--mcp-config", buildMcpConfigJson(capabilities.mcp_configs, proxyUrl, proxyToken));
  }

  // For Crafters: add the project directory as an allowed dir
  // (Claude Code's cwd is allowed by default; --add-dir extends that)
  if (capabilities.filesystem_root !== undefined) {
    args.push("--add-dir", capabilities.filesystem_root);
  }

  // Scoped state access: agents only see their own project's task files.
  // This prevents cross-project reads without breaking any legitimate agent workflow.
  // Use absolute paths — the agent's cwd may be a project directory, not Simulacra root.
  const stateBase = path.resolve("state");
  if (context.project_slug !== undefined) {
    // Project-scoped agents: only their project's task directory
    args.push("--add-dir", path.join(stateBase, "tasks", context.project_slug));
  } else {
    // Non-project agents (e.g. kickoff council): access all task directories
    args.push("--add-dir", path.join(stateBase, "tasks"));
  }
  // Shared state directories that all agents legitimately need
  args.push("--add-dir", path.join(stateBase, "agents"));
  args.push("--add-dir", path.join(stateBase, "approvals"));
  args.push("--add-dir", path.join(stateBase, "inbox"));
  args.push("--add-dir", path.join(stateBase, "knowledge"));
  args.push("--add-dir", path.join(stateBase, "drift"));
  args.push("--add-dir", path.join(stateBase, "projects"));
  args.push("--add-dir", path.join(stateBase, "archive"));

  // Prompt is delivered via stdin (not as a positional arg) so that newlines
  // are never mangled by cmd.exe argument quoting on Windows.
  return { args, prompt: buildInitialPrompt(context) };
}

export interface SpawnOptions {
  readonly rolesConfig: RolesConfig;
  readonly simulacraConfig: SimulacraConfig;
  readonly proxyToken?: string;
  readonly onExit?: (result: AgentResult) => void | Promise<void>;
}

/**
 * Spawn a Claude Code agent subprocess with role-appropriate capabilities.
 * Registers the agent in the live registry before spawn and deregisters on exit.
 */
export async function spawnAgent(
  context: AgentContext,
  options: SpawnOptions,
): Promise<{ identity: AgentIdentity; process: ChildProcess }> {
  const spawnedAt = new Date().toISOString();

  const capabilities = resolveCapabilities(
    context.role,
    context.role === "crafter" ? (context.extra_context ?? undefined) : undefined,
    options.rolesConfig,
    options.simulacraConfig,
    context.project_path,
  );

  const identityBase = {
    id: context.agent_id,
    role: context.role,
    spawned_at: spawnedAt,
    ...(context.role === "crafter" && context.extra_context !== undefined
      ? { crafter_type: context.extra_context }
      : {}),
    ...(context.task_file_path !== undefined
      ? { task_id: context.task_file_path }
      : {}),
    ...(context.project_slug !== undefined
      ? { project_slug: context.project_slug }
      : {}),
  };

  const proxyUrl = options.simulacraConfig.mcp_proxy?.enabled === true
    ? `http://127.0.0.1:${options.simulacraConfig.mcp_proxy.port ?? 8899}`
    : undefined;

  const { args: cliArgs, prompt } = await buildClaudeArgs(
    context,
    capabilities,
    options.simulacraConfig.paths.roles_dir,
    proxyUrl,
    options.proxyToken,
  );

  // Spawn from the project root so relative state/ paths resolve correctly.
  // Crafters get their project path as cwd so it becomes the default allowed dir.
  const cwd = capabilities.filesystem_root ?? process.cwd();

  const proc = spawn("claude", [...cliArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    env: buildChildEnv(),
    cwd,
  });

  proc.on("error", (spawnErr: Error) => {
    console.error(`[Spawner] Failed to start agent ${context.agent_id}:`, spawnErr);
  });

  // Deliver prompt via stdin to avoid Windows cmd.exe newline-as-separator mangling.
  // stdin is guaranteed non-null because stdio is set to ["pipe", "pipe", "pipe"]
  proc.stdin!.write(prompt, "utf-8");
  proc.stdin!.end();

  // Only register if spawn succeeded and we have a real PID.
  // If proc.pid is undefined or 0, the spawn failed — don't write a ghost entry to live.json.
  const spawnedPid = proc.pid;
  if (spawnedPid === undefined || spawnedPid === 0) {
    console.error(`[Spawner] Spawn failed for ${context.agent_id} — no PID`);
    const failedIdentity: AgentIdentity = { ...identityBase, pid: 0 };
    return { identity: failedIdentity, process: proc };
  }
  const liveIdentity: AgentIdentity = { ...identityBase, pid: spawnedPid };
  await registerAgent(liveIdentity);

  const taskLabel = context.task_file_path ?? "(no task)";
  console.log(`[Agent] SPAWN  ${context.agent_id}  role=${context.role}  task=${taskLabel}`);
  logEvent({
    t: new Date().toISOString(), lvl: "info", c: "Spawner", ev: "agent_spawn",
    agent_id: context.agent_id,
    ...(context.project_slug !== undefined ? { project: context.project_slug } : {}),
    ...(context.task_file_path !== undefined ? { task_id: context.task_file_path } : {}),
    role: context.role, pid: spawnedPid,
  });

  const logPath = path.resolve(`logs/${context.agent_id}.log`);
  await fs.mkdir(path.resolve("logs"), { recursive: true });

  const stdoutChunks: Buffer[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    void fs.appendFile(logPath, chunk).catch(() => undefined);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[${context.agent_id}] ${chunk.toString()}`);
    void fs.appendFile(logPath, chunk).catch(() => undefined);
  });

  const startTime = Date.now();

  // ── Execution timeout ────────────────────────────────────────────────────────
  // Kill the agent if it runs longer than the configured timeout.
  const timeoutMs = options.simulacraConfig.orchestrator?.agent_timeout_ms;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      const mins = Math.round(timeoutMs / 60_000);
      console.warn(`[Spawner] TIMEOUT  ${context.agent_id}  (${mins}m limit) — sending SIGTERM`);
      logEvent({
        t: new Date().toISOString(), lvl: "warn", c: "Spawner", ev: "agent_timeout",
        agent_id: context.agent_id,
        ...(context.project_slug !== undefined ? { project: context.project_slug } : {}),
        ...(context.task_file_path !== undefined ? { task_id: context.task_file_path } : {}),
        msg: `Agent killed after ${mins}m timeout`,
      });
      proc.kill("SIGTERM");
      // Escalate to SIGKILL if still alive after 5 seconds
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }, 5_000);
    }, timeoutMs);
  }

  proc.on("exit", (code) => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    const durationMs = Date.now() - startTime;
    const resultBase = {
      agent_id: context.agent_id,
      success: code === 0,
      exit_code: code ?? 1,
      duration_ms: durationMs,
    };
    const result: AgentResult = code !== 0
      ? { ...resultBase, timed_out: timedOut, error: timedOut ? `Timed out after ${String(timeoutMs)}ms` : `Exited with code ${String(code)}` }
      : resultBase;

    // Parse the JSON result and print a human-readable summary to the console.
    const rawOut = Buffer.concat(stdoutChunks).toString("utf-8").trim();
    let parsedCostUsd = 0;
    if (code === 0 && rawOut.length > 0) {
      try {
        const parsed = JSON.parse(rawOut) as Record<string, unknown>;
        const summary = typeof parsed["result"] === "string"
          ? parsed["result"]
          : "(no result text)";
        const turns = typeof parsed["num_turns"] === "number" ? parsed["num_turns"] : "?";
        parsedCostUsd = typeof parsed["total_cost_usd"] === "number"
          ? (parsed["total_cost_usd"] as number)
          : 0;
        const costStr = parsedCostUsd > 0 ? `$${parsedCostUsd.toFixed(4)}` : "";
        console.log(
          `[Agent] DONE   ${context.agent_id}  turns=${String(turns)}  ${costStr}  (${String(Math.round(durationMs / 1000))}s)\n` +
          `        ${summary.replace(/\n/g, "\n        ")}`,
        );
      } catch {
        console.log(`[Agent] DONE   ${context.agent_id}  (${String(Math.round(durationMs / 1000))}s) — could not parse result`);
      }
    } else if (code !== 0) {
      console.error(`[Agent] FAIL   ${context.agent_id}  exit=${String(code)}  (${String(Math.round(durationMs / 1000))}s)`);
    }

    // ── Structured log ───────────────────────────────────────────────────────
    logEvent({
      t: new Date().toISOString(),
      lvl: code === 0 ? "info" : "error",
      c: "Spawner",
      ev: code === 0 ? "agent_done" : "agent_fail",
      agent_id: context.agent_id,
      ...(context.project_slug !== undefined ? { project: context.project_slug } : {}),
      ...(context.task_file_path !== undefined ? { task_id: context.task_file_path } : {}),
      ...(parsedCostUsd > 0 ? { cost_usd: parsedCostUsd } : {}),
      duration_ms: durationMs,
      exit_code: code ?? 1,
      ...(timedOut ? { timed_out: true as const } : {}),
    });

    // ── Per-project cost tracking ────────────────────────────────────────────
    if (parsedCostUsd > 0 && context.project_slug !== undefined) {
      const costEntry: AgentCostEntry = {
        agent_id: context.agent_id,
        role: context.role,
        ...(context.task_file_path !== undefined ? { task_id: context.task_file_path } : {}),
        cost_usd: parsedCostUsd,
        duration_ms: durationMs,
        timestamp: new Date().toISOString(),
      };
      const costsPath = `state/projects/${context.project_slug}/costs.jsonl`;
      void appendLine(costsPath, JSON.stringify(costEntry)).catch((err: unknown) => {
        console.error(`[Spawner] Failed to write cost entry for ${context.agent_id}:`, err);
      });
    }

    // Deregister before calling onExit so that crash recovery and task-status
    // reset logic in onExit sees an accurate registry (agent already removed).
    void (async () => {
      await deregisterAgent(context.agent_id).catch((err: unknown) => {
        console.error(`[Spawner] Failed to deregister agent ${context.agent_id}:`, err);
      });
      if (options.onExit !== undefined) {
        await Promise.resolve(options.onExit(result)).catch((err: unknown) => {
          console.error(`[Spawner] onExit callback error for ${context.agent_id}:`, err);
        });
      }
    })();
  });

  return { identity: liveIdentity, process: proc };
}

export { readRegistry, deregisterAgent };
