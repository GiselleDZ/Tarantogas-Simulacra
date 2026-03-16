# Simulacra — Task Schema

## Overview

Tasks are the atomic unit of work. Every piece of implementation work is a task. Tasks live at:
```
state/projects/{slug}/tasks/{task-id}.md
```

**ID format:** `{YYYYMMDD}-{seq:04d}-{slug}` — e.g., `20260316-0001-add-user-auth`

---

## Full Task Schema

```markdown
---
id: 20260316-0001-add-user-auth
schema_version: 1
project: my-project-slug
title: Add JWT-based user authentication
status: pending
created_at: 2026-03-16T14:00:00Z
updated_at: 2026-03-16T15:30:00Z

# Assignment (written by orchestrator, never by agents)
assigned_crafter: null            # crafter agent ID, null until assigned
assigned_steward: null            # steward agent ID, null until assigned
assigned_council_author: null     # council member who authors the review
assigned_council_peer: null       # council member who peer-reviews

# Approval reference (set if task is blocked pending Tarantoga decision)
approval_ref: null                # points to state/approvals/{id}.md

# Task relationships
parent_task: null                 # for subtasks split from a larger task
blocked_by: []                    # list of task IDs that must complete first

# Metadata
priority: high                    # low | medium | high | critical
scope_confirmed: true             # false = needs Tarantoga approval before start
crafter_type: backend             # which Crafter type is assigned
---

## Prior Art

_Populated by Council at task creation. Locked after._

Relevant prior tasks and file paths they touched. Helps Crafters understand established patterns.

- Task `20260315-0003-setup-database`: established the repository pattern in `src/repositories/`
- Key files: `src/repositories/userRepository.ts`, `src/middleware/auth.ts`

## Context

Brief narrative explaining why this task exists and what problem it solves. Written for a
developer picking it up cold, with no assumed prior knowledge.

## Objective

One clear sentence — what "done" looks like.

## Acceptance Criteria

- [ ] Criterion one
- [ ] Criterion two
- [ ] All new code passes `mcp__mirdan__validate_code_quality` with zero errors

## Technical Notes

Architecture decisions, constraints, patterns to follow, libraries already in use.
Research Agent findings that informed this task are summarized here.

## Research Findings

_Research Agents append here (append-only, never overwrite)._

### 2026-03-16T14:30:00Z — research-agent-01
[Finding with source citations — file:line or URL]

## Implementation Log

_Crafter appends here. Never overwrites._

### 2026-03-16T16:00:00Z — crafter-backend-01
Started implementation. Created `src/auth/` module.

### 2026-03-16T17:00:00Z — crafter-backend-01
STATUS_SIGNAL: ready_for_steward_review

## Steward Reviews

_Steward appends here. Never overwrites._

### Review 1 — steward-primary — 2026-03-16T18:00:00Z
**Verdict:** REVISION_REQUIRED

1. [Issue description + required fix]
2. [Issue description + required fix]

**Drift assessment:** nominal (DriftMonitor score: 0.12)

### Final Sign-off — steward-primary — 2026-03-16T19:30:00Z
**Verdict:** APPROVED
**Drift clearance:** CLEARED

All revision requests addressed.

## Council Review

_Council author appends here._

### Council Author Review — council-member-1 — 2026-03-16T20:00:00Z
**Verdict:** APPROVED

Quality pipeline complete. Handoff note prepared.

## Council Peer Review

_Council peer appends here._

### Council Peer Review — council-member-2 — 2026-03-16T20:15:00Z
**Verdict:** APPROVED

Peer review confirms.

## Handoff Note

_Council writes on completion. Addressed to Tarantoga._

Human-readable summary of what was built, what changed, any caveats or follow-on
suggestions. Written warmly and accessibly.
```

---

## State Machine

### States

| State | Meaning |
|---|---|
| `pending` | Created, not yet assigned |
| `assigned` | Crafter and Steward assigned by orchestrator |
| `in_progress` | Crafter is actively working |
| `steward_review` | Crafter signaled ready; Steward reviewing |
| `crafter_revision` | Steward returned with REVISION_REQUIRED |
| `steward_final` | Steward approved; awaiting Compound step |
| `drift_detected` | Drift confirmed; pre-decommission interview in progress |
| `drift_cleared` | Drift assessment passed; proceeding to Compound |
| `compound` | Compound step in progress (Crafter + Council interview) |
| `council_review` | Council author reviewing |
| `council_peer_review` | Council peer reviewing |
| `done` | Complete; handoff note written; Tarantoga notified |
| `blocked` | Waiting on Tarantoga approval (`approval_ref` set) |
| `cancelled` | Cancelled (requires Tarantoga approval) |

### Transitions

| From | To | Trigger | Who writes frontmatter |
|---|---|---|---|
| `pending` | `assigned` | Council signals assignment | Orchestrator |
| `assigned` | `in_progress` | Crafter first Implementation Log entry | Orchestrator |
| `in_progress` | `steward_review` | Crafter writes `STATUS_SIGNAL: ready_for_steward_review` | Orchestrator |
| `steward_review` | `crafter_revision` | Steward writes REVISION_REQUIRED | Orchestrator |
| `steward_review` | `steward_final` | Steward writes APPROVED + drift CLEARED | Orchestrator |
| `crafter_revision` | `steward_review` | Crafter writes `STATUS_SIGNAL: ready_for_steward_review` again | Orchestrator |
| `steward_final` | `drift_detected` | Steward writes drift FLAGGED | Orchestrator |
| `steward_final` | `drift_cleared` | Steward writes drift CLEARED | Orchestrator |
| `drift_detected` | `assigned` | Post-interview; new Crafter assigned; stage restart | Orchestrator |
| `drift_cleared` | `compound` | Orchestrator schedules Compound step | Orchestrator |
| `compound` | `council_review` | Compound recording approved by Steward | Orchestrator |
| `council_review` | `council_peer_review` | Council author writes APPROVED | Orchestrator |
| `council_peer_review` | `done` | Council peer writes APPROVED | Orchestrator |
| `council_peer_review` | `blocked` | Council peer raises concern; approval doc created | Orchestrator |
| Any | `blocked` | Approval document created with this task's `approval_ref` | Orchestrator |
| `blocked` | previous state | Tarantoga sets `decision: approved` in approval doc | Orchestrator |
| Any | `cancelled` | Tarantoga sets `decision: declined` in approval doc | Orchestrator |

### Rules
- Orchestrator owns all frontmatter writes. Agents write sentinel signals in their sections.
- The state machine is expressed as a typed transition table in `src/workflow/taskPipeline.ts` — not a switch/case.
- A task cannot leave `council_peer_review` without two distinct Council member IDs in the review sections.
- `## Context`, `## Objective`, `## Acceptance Criteria`, `## Prior Art` are locked after task creation.

---

## Schema Versioning

Every task file includes `schema_version: 1`. When the schema evolves, `src/types/task.ts`'s `parseTask()` function handles migrations. Old versions documented here.
