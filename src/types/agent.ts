export type AgentRole = "council" | "research" | "steward" | "crafter";

export interface AgentIdentity {
  readonly id: string;
  readonly role: AgentRole;
  readonly crafter_type?: string;
  readonly spawned_at: string;
  readonly pid: number;
  /** Task this agent is working on, if applicable */
  readonly task_id?: string;
  readonly project_slug?: string;
}

/** The live agent registry entry written before spawn */
export type LiveAgentRegistry = Record<string, AgentIdentity>;

/** MCP server configuration from simulacra.yaml */
export interface McpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Resolved capabilities for a specific agent spawn */
export interface AgentCapabilities {
  readonly permitted_mcps: readonly string[];
  readonly mcp_configs: Readonly<Record<string, McpServerConfig>>;
  /** For Crafters: the absolute path they may access */
  readonly filesystem_root?: string;
}

/** Context bundle passed to a spawned agent */
export interface AgentContext {
  readonly role: AgentRole;
  readonly agent_id: string;
  readonly task_file_path?: string;
  readonly project_path?: string;
  readonly project_slug?: string;
  readonly extra_context?: string;
}

/** Result returned when an agent completes */
export interface AgentResult {
  readonly agent_id: string;
  readonly success: boolean;
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly error?: string;
}
