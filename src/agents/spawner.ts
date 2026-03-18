import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { promises as fs } from "fs";
import { writeFile, readFile } from "../io/fileStore.js";
import { FileLock } from "../io/lock.js";
import type {
  AgentRole,
  AgentIdentity,
  AgentCapabilities,
  AgentContext,
  AgentResult,
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
function resolveCapabilities(
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
 */
function buildMcpConfigJson(mcpConfigs: Record<string, McpServerConfig>): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(mcpConfigs)) {
    mcpServers[name] = {
      command: cfg.command,
      args: [...cfg.args],
      ...(cfg.env !== undefined ? { env: cfg.env } : {}),
    };
  }
  return JSON.stringify({ mcpServers });
}

/**
 * Build the initial prompt that tells the agent what to do.
 * Since we use --print (non-interactive), this is the agent's entry point.
 */
function buildInitialPrompt(context: AgentContext): string {
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
 * Build the verified `claude` CLI arguments for this agent spawn.
 * All flags here are confirmed against `claude --help`.
 */
async function buildClaudeArgs(
  context: AgentContext,
  capabilities: AgentCapabilities,
  rolesDir: string,
): Promise<{ args: readonly string[]; prompt: string }> {
  const args: string[] = [
    // Non-interactive agentic mode — agent runs, uses tools, exits
    "--print",
    // Agents must edit files and run commands without human approval prompts
    "--permission-mode", "bypassPermissions",
    // Output format for machine-readable parsing
    "--output-format", "json",
  ];

  // Inject role CLAUDE.md as an appended system prompt
  const roleMdPath = path.join(rolesDir, context.role, "CLAUDE.md");
  const roleMdContent = await readFile(roleMdPath);
  if (roleMdContent !== null) {
    args.push("--append-system-prompt", roleMdContent);
  }

  // MCP servers for this role
  if (Object.keys(capabilities.mcp_configs).length > 0) {
    args.push("--mcp-config", buildMcpConfigJson(capabilities.mcp_configs));
  }

  // For Crafters: add the project directory and state/ as allowed dirs
  // (Claude Code's cwd is allowed by default; --add-dir extends that)
  if (capabilities.filesystem_root !== undefined) {
    args.push("--add-dir", capabilities.filesystem_root);
  }
  // All agents need access to state/ for task files, drift checks, etc.
  // Use absolute path — the agent's cwd may be a project directory, not Simulacra root.
  args.push("--add-dir", path.resolve("state"));

  // Prompt is delivered via stdin (not as a positional arg) so that newlines
  // are never mangled by cmd.exe argument quoting on Windows.
  return { args, prompt: buildInitialPrompt(context) };
}

export interface SpawnOptions {
  readonly rolesConfig: RolesConfig;
  readonly simulacraConfig: SimulacraConfig;
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
    pid: 0 as number,
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
  const identity: AgentIdentity = identityBase;

  const { args: cliArgs, prompt } = await buildClaudeArgs(
    context,
    capabilities,
    options.simulacraConfig.paths.roles_dir,
  );

  // Spawn from the project root so relative state/ paths resolve correctly.
  // Crafters get their project path as cwd so it becomes the default allowed dir.
  const cwd = capabilities.filesystem_root ?? process.cwd();

  const proc = spawn("claude", [...cliArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    cwd,
  });

  proc.on("error", (spawnErr: Error) => {
    console.error(`[Spawner] Failed to start agent ${context.agent_id}:`, spawnErr);
  });

  // Deliver prompt via stdin to avoid Windows cmd.exe newline-as-separator mangling.
  proc.stdin!.write(prompt, "utf-8");
  proc.stdin!.end();

  const liveIdentity: AgentIdentity = { ...identity, pid: proc.pid ?? 0 };
  await registerAgent(liveIdentity);

  const taskLabel = context.task_file_path ?? "(no task)";
  console.log(`[Agent] SPAWN  ${context.agent_id}  role=${context.role}  task=${taskLabel}`);

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

  proc.on("exit", (code) => {
    const durationMs = Date.now() - startTime;
    const resultBase = {
      agent_id: context.agent_id,
      success: code === 0,
      exit_code: code ?? 1,
      duration_ms: durationMs,
    };
    const result: AgentResult = code !== 0
      ? { ...resultBase, error: `Exited with code ${String(code)}` }
      : resultBase;

    // Parse the JSON result and print a human-readable summary to the console.
    const rawOut = Buffer.concat(stdoutChunks).toString("utf-8").trim();
    if (code === 0 && rawOut.length > 0) {
      try {
        const parsed = JSON.parse(rawOut) as Record<string, unknown>;
        const summary = typeof parsed["result"] === "string"
          ? parsed["result"]
          : "(no result text)";
        const turns = typeof parsed["num_turns"] === "number" ? parsed["num_turns"] : "?";
        const costUsd = typeof parsed["total_cost_usd"] === "number"
          ? `$${(parsed["total_cost_usd"] as number).toFixed(4)}`
          : "";
        console.log(
          `[Agent] DONE   ${context.agent_id}  turns=${String(turns)}  ${costUsd}  (${String(Math.round(durationMs / 1000))}s)\n` +
          `        ${summary.replace(/\n/g, "\n        ")}`,
        );
      } catch {
        console.log(`[Agent] DONE   ${context.agent_id}  (${String(Math.round(durationMs / 1000))}s) — could not parse result`);
      }
    } else if (code !== 0) {
      console.error(`[Agent] FAIL   ${context.agent_id}  exit=${String(code)}  (${String(Math.round(durationMs / 1000))}s)`);
    }

    void deregisterAgent(context.agent_id).catch((err: unknown) => {
      console.error(`[Spawner] Failed to deregister agent ${context.agent_id}:`, err);
    });

    if (options.onExit !== undefined) {
      void Promise.resolve(options.onExit(result)).catch((err: unknown) => {
        console.error(`[Spawner] onExit callback error for ${context.agent_id}:`, err);
      });
    }
  });

  return { identity: liveIdentity, process: proc };
}

export { readRegistry, deregisterAgent };
