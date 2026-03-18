export type ApprovalType =
  | "new_task"
  | "new_mcp"
  | "new_crafter_type"
  | "project_assignment"
  | "plan_approval"
  | "scope_change"
  | "out_of_scope_finding"
  | "task_cancellation"
  | "design_decision"
  | "research_request"
  | "implementation_ambiguity";

export type ApprovalStatus =
  | "pending"
  | "in_conversation"
  | "needs_research"
  | "decided";

export type ApprovalDecision =
  | "approved"
  | "declined"
  | "deferred"
  | "needs_research";

export type CouncilRecommendation = "approve" | "decline" | "needs_research";

export interface ApprovalFrontmatter {
  readonly id: string;
  readonly schema_version: number;
  readonly type: ApprovalType;
  status: ApprovalStatus;
  readonly created_at: string;
  updated_at: string;
  readonly created_by: string;
  readonly project: string | null;
  readonly council_recommendation: CouncilRecommendation;
  /** Tarantoga sets this field to decide */
  decision: ApprovalDecision | null;
  /** Tarantoga writes their reasoning here */
  decision_rationale: string | null;
  needs_more_research: boolean;
  research_request_ref: string | null;
  readonly related_task_refs: readonly string[];
}

export interface Approval {
  readonly frontmatter: ApprovalFrontmatter;
  readonly filePath: string;
  readonly rawContent: string;
}

/** Inbox item — a notification or approval request in Tarantoga's inbox */
export interface InboxItem {
  readonly id: string;
  readonly type: "notification" | "approval_request";
  readonly approval_ref?: string;
  readonly title: string;
  readonly summary: string;
  readonly created_at: string;
  readonly priority: "normal" | "urgent";
}
