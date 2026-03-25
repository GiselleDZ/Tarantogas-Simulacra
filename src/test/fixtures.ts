import type {
  TaskFrontmatter,
  TaskStatus,
  TaskPriority,
  ApprovalFrontmatter,
  ApprovalType,
  CouncilRecommendation,
  AgentIdentity,
  AgentRole,
  AgentContext,
  LiveAgentRegistry,
  ProjectRegistry,
  ProjectStatus,
  DriftBaseline,
} from "../types/index.js";

let counter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${String(++counter).padStart(4, "0")}`;
}

export function resetFixtureCounter(): void {
  counter = 0;
}

export function makeTaskFrontmatter(
  overrides?: Partial<TaskFrontmatter>,
): TaskFrontmatter {
  return {
    id: nextId("task"),
    schema_version: 1,
    project: "test-project",
    title: "Test Task",
    status: "pending" as TaskStatus,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    assigned_crafter: null,
    assigned_steward: null,
    assigned_council_author: null,
    assigned_council_peer: null,
    approval_ref: null,
    parent_task: null,
    blocked_by: [],
    priority: "medium" as TaskPriority,
    scope_confirmed: false,
    crafter_type: "fullstack",
    ...overrides,
  };
}

export function makeApprovalFrontmatter(
  overrides?: Partial<ApprovalFrontmatter>,
): ApprovalFrontmatter {
  return {
    id: nextId("approval"),
    schema_version: 1,
    type: "new_task" as ApprovalType,
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_by: "orchestrator",
    project: "test-project",
    council_recommendation: "approve" as CouncilRecommendation,
    decision: null,
    decision_rationale: null,
    needs_more_research: false,
    research_request_ref: null,
    related_task_refs: [],
    ...overrides,
  };
}

export function makeAgentIdentity(
  overrides?: Partial<AgentIdentity>,
): AgentIdentity {
  return {
    id: nextId("agent"),
    role: "crafter" as AgentRole,
    spawned_at: "2026-01-01T00:00:00.000Z",
    pid: 12345,
    ...overrides,
  };
}

export function makeAgentContext(
  overrides?: Partial<AgentContext>,
): AgentContext {
  return {
    role: "crafter" as AgentRole,
    agent_id: nextId("agent"),
    task_file_path: "state/tasks/test-project/task-001.md",
    project_path: "/projects/test",
    project_slug: "test-project",
    ...overrides,
  };
}

export function makeProjectRegistry(
  overrides?: Partial<ProjectRegistry>,
): ProjectRegistry {
  return {
    slug: "test-project",
    name: "Test Project",
    path: "/projects/test",
    status: "active" as ProjectStatus,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    crafter_types: ["fullstack"],
    active_task_ids: [],
    ...overrides,
  };
}

export function makeDriftBaseline(
  overrides?: Partial<DriftBaseline>,
): DriftBaseline {
  return {
    agent_id: nextId("agent"),
    role: "crafter" as AgentRole,
    probe_responses: ["I am a crafter", "I build features"],
    created_at: "2026-01-01T00:00:00.000Z",
    embedding_vector: new Array<number>(256).fill(0).map((_, i) => (i % 3 === 0 ? 1 : 0)),
    ...overrides,
  };
}

export function makeLiveRegistry(
  entries: AgentIdentity[],
): LiveAgentRegistry {
  const registry: LiveAgentRegistry = {};
  for (const entry of entries) {
    registry[entry.id] = entry;
  }
  return registry;
}
