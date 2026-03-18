/** Task status — the full lifecycle of a unit of work */
export type TaskStatus =
  | "pending"
  | "research_pending"
  | "research_review"
  | "assigned"
  | "in_progress"
  | "steward_review"
  | "crafter_revision"
  | "steward_final"
  | "drift_detected"
  | "drift_cleared"
  | "compound"
  | "council_review"
  | "council_peer_review"
  | "done"
  | "blocked"
  | "cancelled";

export type TaskPriority = "low" | "medium" | "high" | "critical";

/** Parsed representation of a task file's frontmatter */
export interface TaskFrontmatter {
  readonly id: string;
  readonly schema_version: number;
  readonly project: string;
  readonly title: string;
  status: TaskStatus;
  readonly created_at: string;
  updated_at: string;
  assigned_crafter: string | null;
  assigned_steward: string | null;
  assigned_council_author: string | null;
  assigned_council_peer: string | null;
  approval_ref: string | null;
  readonly parent_task: string | null;
  readonly blocked_by: readonly string[];
  readonly priority: TaskPriority;
  scope_confirmed: boolean;
  readonly crafter_type: string;
  readonly project_path?: string;
  /** Paths to research documents the Crafter must read before implementing */
  readonly research_doc_refs?: readonly string[];
  /** Council's token estimate before task assignment — null until estimated */
  estimated_context_tokens?: number | null;
}

/** Sentinel signals agents write to their sections to trigger transitions */
export type TaskSentinel =
  | "STATUS_SIGNAL: ready_for_steward_review"
  | "DRIFT_SIGNAL: CLEARED"
  | "DRIFT_SIGNAL: FLAGGED"
  | "COMPOUND_SIGNAL: complete"
  | "COUNCIL_SIGNAL: APPROVED"
  | "COUNCIL_SIGNAL: REVISION_REQUIRED"
  | "RESEARCH_SIGNAL: commissioned"
  | "RESEARCH_SIGNAL: complete"
  | "RESEARCH_SIGNAL: approved";

/** A complete parsed task document */
export interface Task {
  readonly frontmatter: TaskFrontmatter;
  readonly filePath: string;
  readonly rawContent: string;
}

/** State transition rule in the typed transition table */
export interface TransitionRule {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  /** The sentinel string that triggers this transition */
  readonly sentinel: string;
  /** Which section the sentinel must appear in */
  readonly section: string;
  /** ID field that must be set before this transition is valid */
  readonly requiredField?: keyof TaskFrontmatter;
}
