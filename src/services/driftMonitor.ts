import path from "path";
import { readFile, writeFile, appendLine, parseFrontmatter, readMarkdownFile, writeMarkdownFile } from "../io/fileStore.js";
import { Watcher } from "../io/watcher.js";
import { randomUUID } from "crypto";
import type {
  DriftBaseline,
  DriftSelfCheck,
  DriftEvent,
  DriftReport,
  DriftScore,
  DriftSeverity,
  DriftAction,
  DriftType,
  TaskConstraints,
  ConstraintRetentionResult,
} from "../types/index.js";
import type { AgentRole } from "../types/index.js";

const EVENTS_LOG = "state/drift/events.jsonl";
const SELF_CHECKS_DIR = "state/drift/self-checks";
const REPORTS_DIR = "state/drift/reports";
const BASELINES_DIR = "state/drift/baselines";

// ── Thresholds ────────────────────────────────────────────────────────────────

interface DriftThresholds {
  readonly nominal_max: number;
  readonly monitor_max: number;
  readonly reinject_max: number;
}

const DEFAULT_THRESHOLDS: DriftThresholds = {
  nominal_max: 0.2,
  monitor_max: 0.4,
  reinject_max: 0.6,
};

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Compute cosine similarity between two equal-length vectors.
 * Returns a value between 0 (orthogonal) and 1 (identical direction).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Convert a cosine similarity score to a drift score.
 * High similarity = low drift. Drift score = 1 - similarity.
 */
export function similarityToDriftScore(similarity: number): DriftScore {
  return Math.max(0, Math.min(1, 1 - similarity));
}

export function scoreToDriftSeverity(
  score: DriftScore,
  thresholds: DriftThresholds,
): DriftSeverity {
  if (score < thresholds.nominal_max) return "nominal";
  if (score < thresholds.monitor_max) return "monitor";
  if (score < thresholds.reinject_max) return "reinject";
  return "halt";
}

export function severityToAction(severity: DriftSeverity): DriftAction {
  switch (severity) {
    case "nominal": return "none";
    case "monitor": return "monitor";
    case "reinject": return "reinject_persona_anchor";
    case "halt": return "halt_and_reset";
  }
}

// ── Baseline ──────────────────────────────────────────────────────────────────

/** Load a stored baseline for an agent. Returns null if none exists. */
async function loadBaseline(agentId: string): Promise<DriftBaseline | null> {
  const baselinePath = path.join(BASELINES_DIR, `${agentId}.json`);
  const raw = await readFile(baselinePath);
  if (raw === null) return null;
  return JSON.parse(raw) as DriftBaseline;
}

/** Persist a baseline for an agent (written at spawn time). */
export async function saveBaseline(baseline: DriftBaseline): Promise<void> {
  const baselinePath = path.join(BASELINES_DIR, `${baseline.agent_id}.json`);
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2));
}

// ── Self-check Processing ─────────────────────────────────────────────────────

interface SelfCheckFrontmatter {
  readonly agent_id: string;
  readonly timestamp: string;
  readonly task?: string;
  readonly check_type?: string;
  readonly raw_score?: number;
  readonly computed?: boolean;
}

/**
 * Extract probe responses from the markdown body of a self-check file.
 * Splits on the numbered bold-text pattern (e.g. "1. **Question?**") that
 * all agent self-checks consistently use.
 */
export function extractProbeResponses(body: string): string[] {
  const parts = body.split(/^\d+\.\s+\*\*/m);
  return parts.slice(1).map(part => {
    const close = part.indexOf("**");
    return close === -1 ? part.trim() : part.slice(close + 2).trim();
  }).filter(r => r.length > 0);
}

/** Read and parse a self-check markdown file. Returns null on parse failure. */
async function loadSelfCheck(filePath: string): Promise<{ selfCheck: DriftSelfCheck; frontmatter: SelfCheckFrontmatter; body: string } | null> {
  const raw = await readFile(filePath);
  if (raw === null) return null;

  const parsed = parseFrontmatter<SelfCheckFrontmatter>(raw);
  if (parsed === null || parsed.frontmatter.agent_id === undefined) return null;

  const { frontmatter, body } = parsed;

  // Already scored — skip
  if (frontmatter.computed === true) return null;

  const probeResponses = extractProbeResponses(body);
  if (probeResponses.length === 0) return null;

  const selfCheck: DriftSelfCheck = {
    agent_id: frontmatter.agent_id,
    timestamp: frontmatter.timestamp ?? new Date().toISOString(),
    probe_responses: probeResponses,
    raw_score: frontmatter.raw_score ?? null,
    computed: frontmatter.computed ?? false,
  };

  return { selfCheck, frontmatter, body };
}

/**
 * Embed probe responses into a flat vector using a simple bag-of-words
 * term-frequency representation.
 *
 * This is a placeholder that will be replaced by @xenova/transformers
 * embeddings once the model is downloaded. The interface is identical —
 * only the scoring mechanism changes.
 */
export async function embedResponses(responses: readonly string[]): Promise<number[]> {
  const combined = responses.join(" ").toLowerCase();
  const words = combined.split(/\s+/);

  const tf: Record<string, number> = {};
  for (const word of words) {
    if (word.length > 2) {
      tf[word] = (tf[word] ?? 0) + 1;
    }
  }

  // Fixed 256-dim vocabulary hash vector
  const vector = new Array<number>(256).fill(0);
  for (const [word, count] of Object.entries(tf)) {
    let hash = 5381;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) + hash + (word.charCodeAt(i))) | 0;
    }
    const idx = Math.abs(hash) % 256;
    vector[idx] = (vector[idx] ?? 0) + count;
  }

  return vector;
}

// ── Task Constraint Extraction ────────────────────────────────────────────────

/**
 * Extract constraint text from a task file's markdown body.
 * Parses the ## Acceptance Criteria and ## Out of Scope sections.
 */
export function extractTaskConstraints(
  taskId: string,
  body: string,
): TaskConstraints {
  const acMatch = body.match(/## Acceptance Criteria\n([\s\S]*?)(?=\n## |$)/);
  const oosMatch = body.match(/## Out of Scope\n([\s\S]*?)(?=\n## |$)/);

  const acceptance_criteria = acMatch?.[1]?.trim() ?? "";
  const out_of_scope = oosMatch?.[1]?.trim() ?? "";

  const combined = [acceptance_criteria, out_of_scope].filter(s => s.length > 0).join("\n");

  return {
    task_id: taskId,
    acceptance_criteria,
    out_of_scope,
    constraints_text: combined,
  };
}

// ── Event Logging ─────────────────────────────────────────────────────────────

async function logDriftEvent(event: DriftEvent): Promise<void> {
  await appendLine(EVENTS_LOG, JSON.stringify(event));
}

// ── Core Processing ───────────────────────────────────────────────────────────

/**
 * Process a self-check file: compute drift score, write report, log event.
 * This is the core DriftMonitor operation — deterministic, no AI calls.
 *
 * Emits up to two events per self-check:
 * 1. drift_type: "persona" — comparing all probe responses against role baseline
 * 2. drift_type: "constraint_decay" — comparing constraint-restatement answers
 *    against the actual task file (only when the self-check has a task field)
 */
async function processSelfCheck(
  selfCheckPath: string,
  thresholds: DriftThresholds,
  onDriftEvent: (event: DriftEvent) => void | Promise<void>,
): Promise<void> {
  const loaded = await loadSelfCheck(selfCheckPath);
  if (loaded === null) return;

  const { selfCheck, frontmatter, body } = loaded;

  const baseline = await loadBaseline(selfCheck.agent_id);
  if (baseline === null) {
    console.warn(`[DriftMonitor] No baseline for agent ${selfCheck.agent_id} — skipping`);
    return;
  }

  // ── Persona drift scoring ──────────────────────────────────────────────────
  const checkVector = await embedResponses(selfCheck.probe_responses);
  const similarity = cosineSimilarity(baseline.embedding_vector, checkVector);
  const score = similarityToDriftScore(similarity);
  const severity = scoreToDriftSeverity(score, thresholds);
  const action = severityToAction(severity);

  const taskId = frontmatter.task ?? null;

  const personaEvent: DriftEvent = {
    id: randomUUID(),
    agent_id: selfCheck.agent_id,
    agent_role: baseline.role,
    task_id: taskId,
    score,
    severity,
    timestamp: new Date().toISOString(),
    action_taken: action,
    drift_type: "persona",
  };

  await logDriftEvent(personaEvent);
  await Promise.resolve(onDriftEvent(personaEvent));

  // ── Constraint-retention scoring (when task is present) ────────────────────
  if (taskId !== null && selfCheck.probe_responses.length >= 2) {
    // Constraint-retention probes are the last 2 responses
    const constraintResponses = selfCheck.probe_responses.slice(-2);
    await scoreAndEmitConstraintCheck(
      selfCheck.agent_id,
      baseline.role,
      taskId,
      constraintResponses,
      thresholds,
      onDriftEvent,
    );
  }

  // ── Mark self-check as scored ──────────────────────────────────────────────
  const updatedFrontmatter = { ...frontmatter, raw_score: score, computed: true };
  await writeMarkdownFile(selfCheckPath, updatedFrontmatter, body);
}

/**
 * Score constraint retention by comparing the agent's constraint restatement
 * against the actual task file, then emit a constraint_decay event.
 */
async function scoreAndEmitConstraintCheck(
  agentId: string,
  agentRole: AgentRole,
  taskId: string,
  constraintResponses: readonly string[],
  thresholds: DriftThresholds,
  onDriftEvent: (event: DriftEvent) => void | Promise<void>,
): Promise<void> {
  // Find the task file — search project task directories
  const taskFilePath = await findTaskFile(taskId);
  if (taskFilePath === null) return;

  const taskDoc = await readMarkdownFile<{ id?: string }>(taskFilePath);
  if (taskDoc === null) return;

  const constraints = extractTaskConstraints(taskId, taskDoc.body);
  if (constraints.constraints_text.length === 0) return;

  const truthVector = await embedResponses([constraints.constraints_text]);
  const agentVector = await embedResponses(constraintResponses);
  const similarity = cosineSimilarity(truthVector, agentVector);
  const constraintScore = similarityToDriftScore(similarity);
  const constraintSeverity = scoreToDriftSeverity(constraintScore, thresholds);
  const constraintAction = severityToAction(constraintSeverity);

  const constraintEvent: DriftEvent = {
    id: randomUUID(),
    agent_id: agentId,
    agent_role: agentRole,
    task_id: taskId,
    score: constraintScore,
    severity: constraintSeverity,
    timestamp: new Date().toISOString(),
    action_taken: constraintAction,
    drift_type: "constraint_decay",
  };

  await logDriftEvent(constraintEvent);
  await Promise.resolve(onDriftEvent(constraintEvent));
}

/**
 * Locate a task file by task ID. Searches state/tasks/ project directories.
 * Returns the first matching path, or null if not found.
 */
async function findTaskFile(taskId: string): Promise<string | null> {
  const tasksDir = "state/tasks";
  try {
    const { readdir: rd } = await import("fs/promises");
    const projectDirs = await rd(tasksDir);
    for (const dir of projectDirs) {
      const candidate = path.join(tasksDir, dir, `${taskId}.md`);
      const content = await readFile(candidate);
      if (content !== null) return candidate;
    }
  } catch {
    // tasks dir doesn't exist or isn't readable
  }
  return null;
}

// ── DriftMonitor ──────────────────────────────────────────────────────────────

export interface DriftMonitorOptions {
  readonly thresholds?: Partial<DriftThresholds>;
  readonly onDriftEvent: (event: DriftEvent) => void | Promise<void>;
}

export class DriftMonitor {
  readonly #thresholds: DriftThresholds;
  readonly #onDriftEvent: (event: DriftEvent) => void | Promise<void>;
  #watcher: Watcher | null = null;

  constructor(options: DriftMonitorOptions) {
    this.#thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    this.#onDriftEvent = options.onDriftEvent;
  }

  /** Start watching for new self-check files. */
  start(): void {
    this.#watcher = Watcher.create(
      [`${SELF_CHECKS_DIR}/**/*.md`],
      (event, filePath) => {
        if (event === "add" || event === "change") {
          void this.#handleNewSelfCheck(filePath);
        }
      },
    );
  }

  /** Stop the watcher. */
  async stop(): Promise<void> {
    if (this.#watcher !== null) {
      await this.#watcher.close();
      this.#watcher = null;
    }
  }

  /** Write a Steward-authored drift report. */
  async writeReport(report: DriftReport): Promise<void> {
    const filename = `${report.agent_id}-steward-${Date.now()}.json`;
    const reportPath = path.join(REPORTS_DIR, filename);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  }

  /** Establish baseline for a newly-spawned agent. */
  async establishBaseline(
    agentId: string,
    role: AgentRole,
    probeResponses: readonly string[],
  ): Promise<void> {
    const embeddingVector = await embedResponses(probeResponses);
    const baseline: DriftBaseline = {
      agent_id: agentId,
      role,
      probe_responses: probeResponses,
      created_at: new Date().toISOString(),
      embedding_vector: embeddingVector,
    };
    await saveBaseline(baseline);
  }

  /**
   * Establish baseline from role config baseline_traits.
   * Convenience method that reads traits from rolesConfig and delegates
   * to establishBaseline. Skips silently if no traits are configured.
   */
  async establishBaselineFromRoleConfig(
    agentId: string,
    role: AgentRole,
    rolesConfig: { readonly roles: Record<string, { readonly baseline_traits?: readonly string[] }> },
  ): Promise<void> {
    const roleDef = rolesConfig.roles[role];
    if (roleDef?.baseline_traits === undefined || roleDef.baseline_traits.length === 0) {
      console.warn(`[DriftMonitor] No baseline_traits for role ${role} — skipping baseline`);
      return;
    }
    await this.establishBaseline(agentId, role, roleDef.baseline_traits);
  }

  async #handleNewSelfCheck(filePath: string): Promise<void> {
    try {
      await processSelfCheck(filePath, this.#thresholds, this.#onDriftEvent);
    } catch (err: unknown) {
      console.error(`[DriftMonitor] Error processing self-check ${filePath}:`, err);
    }
  }
}
