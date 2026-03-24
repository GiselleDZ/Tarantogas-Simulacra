export type ProjectStatus =
  | "onboarding_requested"
  | "onboarding_in_progress"
  | "kickoff_pending"
  | "kickoff_in_progress"
  | "kickoff_failed"
  | "active"
  | "declined"
  | "archived";

export interface ProjectRegistry {
  readonly slug: string;
  readonly name: string;
  /** Absolute path to the project repo on disk */
  readonly path: string;
  status: ProjectStatus;
  readonly created_at: string;
  updated_at: string;
  readonly crafter_types: readonly string[];
  /** Task IDs currently active in this project */
  readonly active_task_ids: readonly string[];
  /** Tracks the in-flight plan_approval so orchestrator can correlate decisions back to this project */
  readonly kickoff_plan_approval_ref?: string | null;
}

/** A project plan authored by Council, awaiting Tarantoga approval */
export interface ProjectPlan {
  readonly project_slug: string;
  readonly version: number;
  readonly authored_by: string;
  readonly peer_reviewed_by: string | null;
  readonly created_at: string;
  readonly summary: string;
  /** Draft tasks — not yet created as task files */
  readonly proposed_tasks: readonly ProposedTask[];
  readonly risk_flags: readonly string[];
  readonly questions_for_tarantoga: readonly string[];
}

export interface ProposedTask {
  readonly title: string;
  readonly crafter_type: string;
  readonly priority: "low" | "medium" | "high" | "critical";
  readonly depends_on: readonly string[];
  readonly summary: string;
}
