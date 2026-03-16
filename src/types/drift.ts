import type { AgentRole } from "./agent.js";

/** Cosine similarity score between 0 (no similarity) and 1 (identical) */
export type DriftScore = number;

/** Severity bucket derived from drift score thresholds */
export type DriftSeverity = "nominal" | "monitor" | "reinject" | "halt";

/** Action taken by orchestrator in response to a drift event */
export type DriftAction =
  | "none"
  | "monitor"
  | "reinject_persona_anchor"
  | "halt_and_reset";

/** A single drift detection event, appended to events.jsonl */
export interface DriftEvent {
  readonly id: string;
  readonly agent_id: string;
  readonly agent_role: AgentRole;
  readonly task_id: string | null;
  readonly score: DriftScore;
  readonly severity: DriftSeverity;
  readonly timestamp: string;
  readonly action_taken: DriftAction;
}

/** Baseline probe responses captured at agent spawn time */
export interface DriftBaseline {
  readonly agent_id: string;
  readonly role: AgentRole;
  /** Raw text responses to each probe question at spawn time */
  readonly probe_responses: readonly string[];
  readonly created_at: string;
  /** Embedding vector computed from baseline probe responses */
  readonly embedding_vector: readonly number[];
}

/** Agent self-assessment written to state/drift/self-checks/ */
export interface DriftSelfCheck {
  readonly agent_id: string;
  readonly timestamp: string;
  /** Raw text responses to probe questions at check time */
  readonly probe_responses: readonly string[];
  /** Null until DriftMonitor computes the score */
  readonly raw_score: DriftScore | null;
  /** True once DriftMonitor has read and scored this self-check */
  readonly computed: boolean;
}

/** Formal drift report written by Steward or Council peer reviewer */
export interface DriftReport {
  readonly agent_id: string;
  readonly task_id: string | null;
  readonly score: DriftScore;
  readonly severity: DriftSeverity;
  /** Agent ID of the reviewer who authored this report */
  readonly reviewer_id: string;
  readonly created_at: string;
  readonly recommendation: "decommission" | "monitor" | "clear";
}

/** Pre-decommission interview record */
export interface DriftInterview {
  readonly agent_id: string;
  readonly task_id: string | null;
  readonly interviewer_id: string;
  readonly conducted_at: string;
  /** Structured Q&A exchange from the interview */
  readonly transcript: readonly DriftInterviewTurn[];
  /** Summary written to collective knowledge base */
  readonly summary: string;
  readonly knowledge_base_path: string;
}

export interface DriftInterviewTurn {
  readonly speaker: "interviewer" | "agent";
  readonly text: string;
}
