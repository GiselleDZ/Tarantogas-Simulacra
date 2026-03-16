# Simulacra — Approval Schema

## Overview

Approval documents are how the system surfaces decisions to Tarantoga. Every approval goes to Tarantoga's inbox — there is no Council-internal approval queue. Council peer review happens in task files, not approval documents.

Approvals are conversations, not binary decisions. Tarantoga may ask questions, request more research, or defer to Council before deciding.

**Location:** `state/approvals/{approval-id}.md`

**ID format:** `{YYYYMMDD}-{seq:04d}-{slug}` — e.g., `20260316-0001-new-mcp-playwright`

---

## Approval Types

| Type | Triggered by |
|---|---|
| `new_task` | Work outside the current approved plan |
| `new_mcp` | Request to add a new MCP server |
| `new_crafter_type` | Request to create a new Crafter specialization |
| `project_assignment` | New project being onboarded |
| `plan_approval` | Council-authored project plan awaiting approval |
| `scope_change` | Modifying the scope of an in-progress project |
| `out_of_scope_finding` | Research Agent found something important outside scope (novel to Council) |
| `task_cancellation` | Cancelling a task that is in progress |

---

## Full Approval Schema

```markdown
---
id: 20260316-0001-new-mcp-playwright
schema_version: 1
type: new_mcp
status: pending
created_at: 2026-03-16T14:00:00Z
updated_at: 2026-03-16T16:00:00Z
created_by: council-member-1
project: my-project-slug         # null for system-wide approvals

# Council recommendation
council_recommendation: approve   # approve | decline | needs_research

# Decision (Tarantoga fills these in)
decision: null                    # approved | declined | deferred | needs_research
decision_rationale: null          # Tarantoga writes their reasoning here

# Research
needs_more_research: false
research_request_ref: null        # task ID if research dispatched

# Related work
related_task_refs: []             # task IDs this approval unblocks
---

## Summary

One paragraph — what is being requested and why. Written for Tarantoga.
No jargon. Assume Tarantoga is reading five of these in a row.

## Context and Evidence

### Why This Is Needed
[Concrete explanation. What gap does this fill? What breaks without it?]

### Evidence
[Research findings, task failures, or patterns that surfaced this need]

### Current Workaround (if any)
[What agents are doing today without this approval]

## Pros and Cons

### Reasons to Approve
- [Concrete benefit]

### Reasons to Decline
- [Risk or concern]
- [Alternative if declined]

## Council Recommendation

**Recommendation:** APPROVE

[Council's reasoning — 1–3 paragraphs. What peer-reviewed this and why.
Include dissenting view if peer review was not unanimous.]

## Conversation Thread

This is where the approval conversation happens. Tarantoga and Council both write here.
Every message is appended with timestamp and author. Never edit prior entries.

### 2026-03-16T14:00:00Z — council-member-1
[Initial submission note]

### 2026-03-16T15:00:00Z — tarantoga
[Tarantoga's response — question, concern, or decision signal]

### 2026-03-16T15:30:00Z — council-member-1
[Council's reply]

## Needs More Research

_Populated if more information is required before deciding._

**Research requested:** [what needs to be investigated]
**Research task ref:** [task ID dispatched to Research Agents]
**Research complete:** false
**Research summary:** [populated when research returns]

## Learning Record

_Populated by orchestrator after Tarantoga decides. Feeds Council learning._

**Decision:** approved
**Rationale summary:** [condensed from Tarantoga's stated reasoning]
**Pattern extracted:** [one sentence — what principle does this decision encode?]
```

---

## State Machine

### States

| State | Meaning |
|---|---|
| `pending` | Document created; in Tarantoga's `unread/` inbox |
| `in_conversation` | Tarantoga has replied at least once |
| `needs_research` | More information required; research task dispatched |
| `decided` | Tarantoga has set `decision:` field |

### Transitions

| From | To | Trigger |
|---|---|---|
| `pending` | `in_conversation` | Tarantoga writes to conversation thread |
| `in_conversation` | `needs_research` | Tarantoga or Council sets `needs_more_research: true` |
| `needs_research` | `in_conversation` | Research completes; summary written; status returns to conversation |
| Any | `decided` | Tarantoga sets `decision:` field in frontmatter |

### On Decision

| Decision | Orchestrator action |
|---|---|
| `approved` | Executes the approved action; moves related blocked tasks to previous state |
| `declined` | Cancels related tasks; archives approval |
| `deferred` | Moves approval to `state/inbox/tarantoga/deferred/`; Council takes full authority |
| `needs_research` | Dispatches Research Agents; approval stays in `pending/` until research returns |

---

## Tarantoga's Inbox Model

```
state/inbox/tarantoga/
├── unread/     ← all new items land here (agents write here)
├── urgent/     ← high-priority (check first)
├── pending/    ← read, undecided, no orchestrator action
├── deferred/   ← consciously handed to Council with full authority
└── archive/    ← fully resolved
```

**To process an approval:**
1. Read the document in `unread/` or `urgent/`
2. Move it to `pending/` while deciding
3. Write to the conversation thread if you have questions
4. Set `decision:` and `decision_rationale:` in frontmatter when ready
5. Orchestrator detects the decision and acts

**Deferred** means the decision is no longer yours — Council has full authority. Only use this if you genuinely want Council to decide. For "I need more time," use `pending`. For "I need more information," use `needs_research`.

---

## Plan Approval Loop

If Tarantoga sends a plan back for revision and it is not approved after 3 revision cycles, the approval document automatically surfaces a "needs direct conversation" flag. Tarantoga is asked to either approve the current version with noted reservations or cancel the project onboarding. The conversation thread makes the history of all modifications transparent across cycles.
