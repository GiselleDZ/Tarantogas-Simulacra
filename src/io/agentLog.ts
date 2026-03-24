/**
 * AgentLog — structured console output for agent phase transitions and decisions.
 *
 * Agents write PHASE: and DECISION: lines to their task file sections.
 * The orchestrator calls parseAgentLogLines() on new body content and
 * emits each line via printAgentLogLine() with role-based colour coding.
 *
 * Format: [ROLE:agent-id] [task-id] PHASE | message
 * Colours: Council=purple, Steward=yellow, Crafter=blue, Research=cyan
 */

// ── ANSI colour codes ─────────────────────────────────────────────────────────

const C = {
  council: "\x1b[35m",   // purple
  steward: "\x1b[33m",   // yellow
  crafter: "\x1b[34m",   // blue
  research: "\x1b[36m",  // cyan
  bold: "\x1b[1m",
  reset: "\x1b[0m",
} as const;

export type AgentLogRole = "council" | "steward" | "crafter" | "research";
export type AgentLogLineType = "PHASE" | "DECISION";

export interface AgentLogLine {
  readonly type: AgentLogLineType;
  readonly message: string;
  readonly section: string; // the ## heading active when the line was written
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Extract all PHASE: and DECISION: lines from a block of task body content.
 * Tracks the active ## section heading so callers can derive role from section name.
 * Designed to be called on incremental content (new body appended since last scan).
 */
export function parseAgentLogLines(content: string): AgentLogLine[] {
  const result: AgentLogLine[] = [];
  let currentSection = "";

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    const sectionMatch = /^##\s+(.+)$/.exec(line);
    if (sectionMatch !== null) {
      currentSection = sectionMatch[1]!.trim();
      continue;
    }

    const phaseMatch = /^PHASE:\s*(.+)$/.exec(line);
    if (phaseMatch !== null) {
      result.push({ type: "PHASE", message: phaseMatch[1]!.trim(), section: currentSection });
      continue;
    }

    const decisionMatch = /^DECISION:\s*(.+)$/.exec(line);
    if (decisionMatch !== null) {
      result.push({ type: "DECISION", message: decisionMatch[1]!.trim(), section: currentSection });
    }
  }

  return result;
}

// ── Output ────────────────────────────────────────────────────────────────────

/**
 * Print a single agent log line to stdout with role-based colour coding.
 */
export function printAgentLogLine(
  role: AgentLogRole,
  agentId: string,
  taskId: string,
  line: AgentLogLine,
): void {
  const color = C[role];
  const roleTag = `${color}${C.bold}[${role.toUpperCase()}:${agentId}]${C.reset}`;
  const taskTag = `[${taskId}]`;
  const typeTag = `${C.bold}${line.type}${C.reset}`;

  console.log(`${roleTag} ${taskTag} ${typeTag} | ${line.message}`);
}
