# Simulacra — System Architecture

## What Is This

Simulacra is a hierarchical multi-agent orchestrator built on Claude Code. Multiple Claude Code instances run as agents in defined roles, communicating exclusively via files in a shared `state/` directory. There is no message queue, no database, no external broker. Coordination happens through atomic file writes and a file-watching loop.

The system is designed to run locally, across multiple repos, with a human overseer (Tarantoga) who retains final authority over all scope decisions, approvals, and git operations.

---

## Agent Hierarchy

| Layer | Name | Role |
|---|---|---|
| Human | Tarantoga | Final approver — scope, plans, new MCPs, project assignments |
| AI Orchestration | The Council | Multiple AI agents, every decision peer-reviewed by at least one other member |
| Research | Research Agents | Research-only, cross-cutting. Answer to Council. No filesystem write outside research directory. |
| Supervisory | Stewards | Quality gate on Crafter output. Drift review. |
| Implementation | Crafters | Code only. Hard-sandboxed to assigned project folder. |

### Communication & Tone
- All agent communication via files in a shared directory
- Tone: compassionate, gracious, matriarchal across all agents
- Agents address each other with care — no terse commands

---

## Confirmed Technical Decisions

- **Language:** TypeScript/Node
- **State:** files in `state/` directory (gitignored) — markdown + JSON
- **Git:** Tarantoga owns ALL git actions — agents never touch git
- **Open source:** from day one — clean config layer, no personal config committed
- **No Slack**
- **No activation-space model access** — behavioral approximation used for drift detection

---

## Directory Structure

```
simulacra/
├── CLAUDE.md                        # Global — injected into every agent
├── ARCHITECTURE.md                  # This file
├── README.md
├── package.json
├── tsconfig.json
├── .gitignore
│
├── config/
│   ├── simulacra.example.yaml       # Committed — open-source template
│   ├── simulacra.yaml               # Gitignored — user's live config
│   └── roles.yaml                   # Role → MCP authorization (committed, no secrets)
│
├── docs/
│   ├── architecture.md              # This file
│   ├── agent-roles.md               # Role definitions, tone, authority boundaries
│   ├── task-schema.md               # Task file format and state machine
│   ├── approval-schema.md           # Approval document format and state machine
│   └── persona-drift-research.md    # Drift detection design and research basis
│
├── src/
│   ├── types/                       # TypeScript interfaces — Task, Approval, Project, Agent, Drift
│   ├── io/
│   │   ├── fileStore.ts             # Atomic writes (write-to-tmp, rename) — ALL durability flows here
│   │   ├── watcher.ts               # fs.watch + polling fallback, 500ms debounce
│   │   └── lock.ts                  # Advisory lock files, 30s stale timeout
│   ├── agents/
│   │   ├── spawner.ts               # MCP access control + Crafter sandbox — ALL security flows here
│   │   ├── council.ts               # Council lifecycle
│   │   ├── researchAgent.ts         # Parallel research dispatch
│   │   ├── steward.ts               # Steward review lifecycle
│   │   └── crafter.ts               # Crafter lifecycle + sandbox config
│   ├── workflow/
│   │   ├── onboarding.ts            # Project onboarding sequence
│   │   ├── taskPipeline.ts          # Typed transition table state machine
│   │   └── approvalQueue.ts         # Approval lifecycle
│   ├── services/
│   │   ├── driftMonitor.ts          # Dumb automated drift detection (not an AI agent)
│   │   └── mcpEvaluator.ts          # MCP registry query + recommendation (never installs)
│   ├── learning/
│   │   └── councilLearning.ts       # Prompt augmentation ONLY — never alters routing
│   ├── orchestrator.ts              # Entry point + wiring
│   ├── recovery.ts                  # Crash recovery — reads live.json, re-spawns dead agents
│   └── scheduler.ts                 # Main watch loop
│
├── roles/
│   ├── council/CLAUDE.md
│   ├── research/CLAUDE.md
│   ├── steward/CLAUDE.md
│   └── crafter/CLAUDE.md
│
└── state/                           # GITIGNORED — all runtime state
    ├── agents/
    │   └── live.json                # Active agent registry — written before spawn, cleared on shutdown
    ├── projects/{slug}/
    │   ├── registry.json
    │   ├── plan.md
    │   ├── CLAUDE.md                # Created during onboarding from research findings
    │   ├── tasks/{task-id}.md
    │   ├── tasks/{task-id}/
    │   │   └── collaboration/
    │   │       └── channel.md       # Multi-Crafter collaboration (Council member moderates)
    │   ├── research/{topic}.md
    │   └── handoff/{task-id}-handoff.md
    ├── approvals/{approval-id}.md
    ├── control/{task-id}.cancel     # Tarantoga writes to cancel a task
    ├── drift/
    │   ├── events.jsonl             # Append-only drift event log
    │   ├── self-checks/             # Agent self-assessments
    │   ├── reports/                 # Formal drift reports
    │   └── interviews/              # Pre-decommission interview records
    ├── learning/
    │   ├── council-decisions.jsonl  # Sliding window, token-capped, injected into Council context
    │   └── archive/
    ├── knowledge/
    │   ├── global/
    │   │   ├── frontend/
    │   │   ├── backend/
    │   │   ├── council/
    │   │   ├── research/
    │   │   └── stewards/
    │   └── projects/{slug}/
    │       ├── frontend/
    │       ├── backend/
    │       └── council/
    ├── inbox/
    │   └── tarantoga/
    │       ├── unread/              # Agents write here
    │       ├── urgent/              # High-priority — Tarantoga checks first
    │       ├── pending/             # Read but undecided — no orchestrator action
    │       ├── deferred/            # Handed to Council — Council has full authority
    │       └── archive/             # Fully resolved
    └── archive/                     # Completed tasks older than 30 days
```

---

## Quality Pipeline (Fixed, Every Task)

```
1. Crafter(s) implement
   └── Mid-task drift self-checks every N tool uses

2. Steward reviews (code quality + DriftMonitor report)

3. Crafter(s) improve

4. Steward final sign-off + Tier 2 formal drift assessment
   ├── If drift flagged → pre-decommission interview → knowledge base → decommission → restart
   └── If cleared → proceed

5. Compound step
   └── Crafter(s) + Council member structured interview → knowledge base
   └── Steward reviews compound recording

6. Council review (peer-reviewed by second Council member)

7. Tarantoga notified — finished code + handoff note
```

---

## Task State Machine

```
pending → assigned → in_progress
  [drift self-checks during]
→ steward_review
  [Tier 2 drift assessment]
  ├── drift_detected → [interview → decommission → restart at stage start]
  └── drift_cleared → compound
→ council_review → council_peer_review → done
                                       → blocked (approval_ref set)
                                       → cancelled
```

## Approval State Machine

```
pending → in_conversation → needs_research → decided
```

Decided sub-states: `approved | declined | deferred`

All approval documents go to Tarantoga's inbox. Council peer review happens in task files — not via approval documents.

---

## State Machine Ownership

The **orchestrator** (TypeScript process, not an AI) owns all frontmatter writes. Agents append sentinel signals to their designated sections. Orchestrator validates transitions against a typed transition table, then writes `status:`.

### Section Write Authority

| Section | Writer |
|---|---|
| All frontmatter fields | Orchestrator only |
| `## Implementation Log` | Crafter only |
| `## Steward Reviews` | Steward only |
| `## Research Findings` | Research Agent (append-only) |
| `## Council Review` | Council author only |
| `## Council Peer Review` | Council peer only |
| `## Handoff Note` | Council only |
| `## Prior Art` | Council at task creation, then locked |
| `## Context / Objective / Acceptance Criteria` | Locked after task creation |

---

## Crafter Collective Consciousness

All Crafters of the same type share a collective knowledge base with two layers:

- **Global** (per type): general best practices across all projects
- **Project** (per type per project): project-specific knowledge only

Knowledge bases are isolated by type — frontend Crafters cannot access backend knowledge.

New Crafter types are created via the approval workflow: Council identifies need → Research investigates → Tarantoga approves → MCP acquired → type defined in config → knowledge base scaffolded.

---

## Council Learning

The Council's sliding window of Tarantoga's past decisions (last 50, token-capped) is injected into Council agent context at spawn time as **prompt augmentation only**. It never alters routing logic, state transitions, or approval thresholds.

---

## Approval Inbox Model

Tarantoga's inbox uses a five-folder model:

| Folder | Meaning |
|---|---|
| `unread/` | Not yet read |
| `urgent/` | High-priority — check first |
| `pending/` | Read but undecided — no action |
| `deferred/` | Consciously handed to Council — Council has full authority |
| `archive/` | Fully resolved |

Approval decisions are structured frontmatter fields (`decision: approved | declined | deferred | needs_research`) — never parsed from prose.

---

## Layer Rules (Enforced by Import Linting)

```
io/         — no dependencies on other layers
agents/     — depends on: io/, types/
workflow/   — depends on: agents/, io/, types/
services/   — depends on: io/, types/
learning/   — depends on: io/, types/
orchestrator.ts — depends on: workflow/, services/, learning/, io/
recovery.ts — depends on: agents/, io/, types/
scheduler.ts — depends on: workflow/, io/
```

No layer may import from a layer above it.

---

## Named Limitations

- **Council peer review is a workflow convention, not a cryptographic guarantee.** Agent IDs are self-reported. Two distinct ID strings are required in the task file, but identity is not verified externally.
- **Running agents cannot be mid-flight cancelled.** When Tarantoga writes a `.cancel` file, the orchestrator halts new work on that task. Any currently-running agent subprocess completes its current turn.
- **Git safety relies on MCP scoping, not filesystem enforcement.** The scoped filesystem MCP physically cannot resolve paths outside its root, but `.git/` directory access depends on the MCP server's implementation.
- **Drift detection is behavioral approximation.** The system approximates activation-space monitoring via probe question embedding similarity. This is not equivalent to direct activation-space monitoring and may miss subtle drift.

---

## MCP Access by Role

| Role | Permitted MCPs |
|---|---|
| Council | All configured MCPs |
| Research | context7, github (read), playwright — scoped to `state/projects/{slug}/research/` |
| Steward | mirdan, context7, github (read) |
| Crafter | filesystem (project-scoped), context7, type-specific skills |

Enforcement is in `src/agents/spawner.ts` — the single access control point.

---

## Crash Recovery

1. On startup: read `state/agents/live.json`
2. Check each entry's PID against running processes
3. Re-spawn agents whose PID is dead and whose task is in a non-terminal state
4. Clear stale entries
5. All states are re-entrant by idempotency design — agents check whether their section already exists before writing

---

## Retention

- Completed tasks move to `state/archive/` after 30 days
- Watcher and startup scan exclude `state/archive/`
