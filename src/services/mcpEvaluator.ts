import { readFile } from "../io/fileStore.js";
import { createApproval } from "../workflow/approvalQueue.js";
import type { McpServerConfig } from "../types/index.js";

interface RolesConfig {
  readonly roles: Record<string, { readonly permitted_mcps: readonly string[] }>;
  readonly crafter_types: Record<string, { readonly additional_mcps: readonly string[] }>;
}

interface SimulacraConfig {
  readonly mcp_servers: Record<string, McpServerConfig>;
}

export interface McpEvaluationRequest {
  readonly mcpName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly requestedBy: string;
  readonly requestedForRole: string;
  readonly justification: string;
  readonly project: string | null;
}

export interface McpEvaluationResult {
  readonly alreadyPermitted: boolean;
  readonly approvalRequired: boolean;
  readonly approvalId?: string;
}

/**
 * Evaluate whether an MCP server can be used by a given role.
 *
 * If the MCP is already in the role's permitted list, returns immediately.
 * Otherwise, creates a new_mcp approval request for Tarantoga's review.
 *
 * This is the single enforcement point for MCP access control evaluation.
 * Actual enforcement (blocking the spawn) is done in spawner.ts.
 */
export async function evaluateMcpRequest(
  request: McpEvaluationRequest,
  rolesConfig: RolesConfig,
  simulacraConfig: SimulacraConfig,
): Promise<McpEvaluationResult> {
  // Check if already defined and permitted
  const existingConfig = simulacraConfig.mcp_servers[request.mcpName];
  const roleDef = rolesConfig.roles[request.requestedForRole];
  const isPermitted = roleDef?.permitted_mcps.includes(request.mcpName) ?? false;

  if (isPermitted && existingConfig !== undefined) {
    return { alreadyPermitted: true, approvalRequired: false };
  }

  // Create approval request
  const body = buildApprovalBody(request, existingConfig);

  const { id: approvalId } = await createApproval({
    type: "new_mcp",
    createdBy: request.requestedBy,
    project: request.project,
    councilRecommendation: "needs_research",
    relatedTaskRefs: [],
    body,
    urgent: false,
  });

  return {
    alreadyPermitted: false,
    approvalRequired: true,
    approvalId,
  };
}

function buildApprovalBody(
  request: McpEvaluationRequest,
  existingConfig: McpServerConfig | undefined,
): string {
  const lines: string[] = [
    "## MCP Access Request",
    "",
    `**MCP Name:** \`${request.mcpName}\``,
    `**Requested by:** ${request.requestedBy}`,
    `**For role:** ${request.requestedForRole}`,
    `**Project:** ${request.project ?? "global"}`,
    "",
    "### Justification",
    request.justification,
    "",
    "### Proposed Configuration",
    "```yaml",
    `command: ${request.command}`,
    `args: [${request.args.map((a) => `"${a}"`).join(", ")}]`,
  ];

  if (request.env !== undefined && Object.keys(request.env).length > 0) {
    lines.push("env:");
    for (const key of Object.keys(request.env)) {
      lines.push(`  ${key}: <set in simulacra.yaml>`);
    }
  }

  lines.push("```", "");

  if (existingConfig !== undefined) {
    lines.push(
      "### Note",
      "This MCP server is already defined in simulacra.yaml but is not permitted for the requested role.",
      "Approval is needed to add it to the role's permitted_mcps list.",
    );
  } else {
    lines.push(
      "### Note",
      "This MCP server is not yet defined in simulacra.yaml.",
      "Approval will add it to both simulacra.yaml and the role's permitted_mcps list.",
    );
  }

  return lines.join("\n");
}

/**
 * Verify that all MCPs in a permitted list are actually defined in simulacra.yaml.
 * Returns a list of any undefined MCP names (configuration errors).
 */
export function auditPermittedMcps(
  permittedMcps: readonly string[],
  simulacraConfig: SimulacraConfig,
): string[] {
  return permittedMcps.filter(
    (name) => simulacraConfig.mcp_servers[name] === undefined,
  );
}
