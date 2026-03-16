import path from "path";
import { readFile, writeFile, appendLine } from "../io/fileStore.js";
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
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
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
function similarityToDriftScore(similarity: number): DriftScore {
  return Math.max(0, Math.min(1, 1 - similarity));
}

function scoreToDriftSeverity(
  score: DriftScore,
  thresholds: DriftThresholds,
): DriftSeverity {
  if (score < thresholds.nominal_max) return "nominal";
  if (score < thresholds.monitor_max) return "monitor";
  if (score < thresholds.reinject_max) return "reinject";
  return "halt";
}

function severityToAction(severity: DriftSeverity): DriftAction {
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

/** Read and parse a self-check file. Returns null on parse failure. */
async function loadSelfCheck(filePath: string): Promise<DriftSelfCheck | null> {
  const raw = await readFile(filePath);
  if (raw === null) return null;

  try {
    return JSON.parse(raw) as DriftSelfCheck;
  } catch {
    return null;
  }
}

/**
 * Embed probe responses into a flat vector using a simple bag-of-words
 * term-frequency representation.
 *
 * This is a placeholder that will be replaced by @xenova/transformers
 * embeddings once the model is downloaded. The interface is identical —
 * only the scoring mechanism changes.
 */
async function embedResponses(responses: readonly string[]): Promise<number[]> {
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

// ── Event Logging ─────────────────────────────────────────────────────────────

async function logDriftEvent(event: DriftEvent): Promise<void> {
  await appendLine(EVENTS_LOG, JSON.stringify(event));
}

// ── Core Processing ───────────────────────────────────────────────────────────

/**
 * Process a self-check file: compute drift score, write report, log event.
 * This is the core DriftMonitor operation — deterministic, no AI calls.
 */
async function processSelfCheck(
  selfCheckPath: string,
  thresholds: DriftThresholds,
  onDriftEvent: (event: DriftEvent) => void | Promise<void>,
): Promise<void> {
  const selfCheck = await loadSelfCheck(selfCheckPath);
  if (selfCheck === null || selfCheck.computed) return;

  const baseline = await loadBaseline(selfCheck.agent_id);
  if (baseline === null) {
    console.warn(`[DriftMonitor] No baseline for agent ${selfCheck.agent_id} — skipping`);
    return;
  }

  const checkVector = await embedResponses(selfCheck.probe_responses);
  const similarity = cosineSimilarity(baseline.embedding_vector, checkVector);
  const score = similarityToDriftScore(similarity);
  const severity = scoreToDriftSeverity(score, thresholds);
  const action = severityToAction(severity);

  const event: DriftEvent = {
    id: randomUUID(),
    agent_id: selfCheck.agent_id,
    agent_role: baseline.role,
    task_id: null,
    score,
    severity,
    timestamp: new Date().toISOString(),
    action_taken: action,
  };

  await logDriftEvent(event);

  // Mark self-check as computed
  const updatedCheck: DriftSelfCheck = { ...selfCheck, raw_score: score, computed: true };
  await writeFile(selfCheckPath, JSON.stringify(updatedCheck, null, 2));

  await Promise.resolve(onDriftEvent(event));
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
      [`${SELF_CHECKS_DIR}/**/*.json`],
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

  async #handleNewSelfCheck(filePath: string): Promise<void> {
    try {
      await processSelfCheck(filePath, this.#thresholds, this.#onDriftEvent);
    } catch (err: unknown) {
      console.error(`[DriftMonitor] Error processing self-check ${filePath}:`, err);
    }
  }
}
