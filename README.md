# Simulacra

A hierarchical multi-agent orchestration system built on Claude Code.

---

## What is Simulacra?

Simulacra coordinates multiple Claude Code instances working together as a team on software projects. Each instance has a defined role, clear authority boundaries, and a shared understanding that they are collaborating — not competing. The system is designed to run locally, across one or more repositories, with a human overseer who retains final authority over all significant decisions.

### Philosophy

Simulacra is a **compassion-first, matriarchal** system. Agents address each other with warmth and care. No agent races to finish — each does its job carefully and completely. Escalation is not failure; it is wisdom. When an agent encounters something outside its authority, it surfaces it cleanly and waits.

The name comes from Stanisław Lem's *The Futurological Congress*. In the novel, Tarantoga is the one character who remains tethered to reality — the grounding force amid layers of illusion. The human overseer of this system carries the same name and plays the same role. The architecture is also philosophically indebted to Steve Yegge's Gas Town: the idea that a well-designed system achieves extraordinary things through principled division of labor and genuine trust between its participants.

### How coordination works

All agent communication happens through files in a shared `state/` directory. There is no message queue, no database, no external broker. Coordination is achieved through atomic file writes and a file-watching loop. Every agent knows exactly what section of which file it is permitted to write. The orchestrator — a deterministic TypeScript process, not an AI — owns all frontmatter writes and enforces every state transition.

Tarantoga handles all git operations manually. No agent ever touches git.

---

## The Hierarchy

Simulacra has five tiers. One is human. Four are AI. Every agent operates within strict authority boundaries. No agent may exceed its authority — it escalates instead.

| Tier | Name | Role |
|---|---|---|
| Human | Tarantoga | Final approver — all scope, MCPs, novel decisions, git |
| AI Orchestration | The Council | Plans, peer-reviews every significant decision, holds institutional memory |
| Research | Research Agents | Knowledge-gathering only — no code, no decisions |
| Supervisory | Stewards | Quality gate and drift reviewers |
| Implementation | Crafters | Builders — hard-sandboxed to their assigned project at the MCP level |

> **Every agent knows exactly what it can and cannot do. Escalation is not failure — it is wisdom.**

### Tarantoga

Tarantoga is the human running Simulacra. Every significant decision traces back to them. They interact through an inbox at `state/inbox/tarantoga/` and through approval documents at `state/approvals/`. They are the final authority on scope changes, new MCP servers, new project assignments, and anything not covered by an existing plan.

### The Council

The Council is the top-level AI orchestration layer. Multiple Council members operate simultaneously. Every significant decision is peer-reviewed by at least one other Council member. The Council directs work within the approved plan, approves research requests from Crafters, and makes decisions on known approval patterns without involving Tarantoga. Novel decisions always escalate.

A sliding window of Tarantoga's past decisions — the last 50, token-capped — is injected into Council context at spawn time as prompt augmentation. This never alters routing logic or state transitions; it only informs judgment.

### Research Agents

Research Agents gather knowledge. They do not write code. They do not make decisions. They analyze and surface findings to the rest of the system. Multiple Research Agents run simultaneously — breadth is a feature. Their filesystem access is scoped at the MCP level: they can only write to `state/projects/{slug}/research/`. They cannot accidentally modify implementation files.

### Stewards

Stewards are the quality gate. Their sign-off is what stands between crafted work and the Council. Every Steward review covers code quality, security, architecture, naming conventions, acceptance criteria, and the DriftMonitor report for the session. Verdicts are never ambiguous: `REVISION_REQUIRED` or `APPROVED`. Stewards are specific, constructive, and acknowledge what has been done well. They are also responsible for formal drift review before the Compound step.

### Crafters

Crafters build. They implement what has been assigned and nothing else. Their filesystem access is hard-scoped to their assigned project root at the MCP server level — not by convention, but by the physical incapacity of a scoped filesystem MCP to resolve paths outside its configured root. When they discover something outside their scope, they write a finding and escalate. They do not quietly fix it.

The Crafter lifecycle is currently being redesigned. See [Crafter Roles](#crafter-roles) below.

---

## The Quality Pipeline

Every task passes through a fixed seven-stage pipeline. The pipeline is not optional and cannot be short-circuited.

```
1. Crafter(s) implement
   └── Drift self-checks every N tool uses (Tier 1 monitoring)

2. Steward reviews
   └── Code quality, security, architecture, acceptance criteria, DriftMonitor report

3. Crafter(s) revise
   └── Every revision request is numbered, specific, and actionable

4. Steward final sign-off + Tier 2 formal drift assessment
   ├── Drift flagged → pre-decommission interview → knowledge base → decommission → stage restart
   └── Drift cleared → proceed

5. Compound step  ← the knowledge-feeding heartbeat of the system
   └── Crafter(s) and a Council member conduct a structured interview
   └── Findings written to the collective knowledge base
   └── Steward reviews the recording before it is committed

6. Council review
   └── Council author reviews the completed work

7. Council peer review → Tarantoga notified
   └── A second, distinct Council member independently reviews
   └── Tarantoga receives the finished code and handoff note
```

The Compound step is the most distinctive element of the pipeline. It is not a formality — it is the mechanism by which knowledge accumulates. Every task makes the next Crafter of the same type slightly more capable, because what was learned gets written down and passed forward.

---

## How It Works: File-Based Coordination

### The orchestrator

The orchestrator (`src/orchestrator.ts`) is a dumb TypeScript process. It reads state, evaluates a typed transition table, applies rules, and writes frontmatter. It never makes AI decisions. It uses chokidar for file watching with a 500ms polling fallback.

Every state transition is defined in `src/workflow/taskPipeline.ts` as a typed rule: a `from` state, a `to` state, a `sentinel` string, and the `section` that sentinel must appear in. The orchestrator looks for that exact string in that exact section — nothing more.

### Section ownership

Every agent has a designated section of the task file. An agent writes only to its section. The orchestrator owns all frontmatter.

| Section | Writer |
|---|---|
| All frontmatter fields | Orchestrator only |
| `## Crafter Work` | Crafter only |
| `## Steward Review` / `## Steward Final` | Steward only |
| `## Research Findings` | Research Agent (append-only) |
| `## Council Review` | Council author only |
| `## Council Peer Review` | Council peer only |
| `## Compound Step` | Council (Compound interview) |
| `## Handoff Note` | Council only |

### Sentinel signals

Agents communicate state transitions by appending sentinel strings to their designated section. The orchestrator detects these and performs the actual frontmatter update. Agents never write frontmatter directly.

```
STATUS_SIGNAL: ready_for_steward_review    ← Crafter signals work is ready
DRIFT_SIGNAL: CLEARED                      ← Steward clears the drift assessment
COMPOUND_SIGNAL: complete                  ← Council records Compound step complete
COUNCIL_SIGNAL: APPROVED                   ← Council approves (author or peer)
```

### Full state machine

```
pending → assigned → in_progress → steward_review → crafter_revision
       → steward_final → compound → council_review → council_peer_review → done

Drift intercepts steward_final:
  steward_final → drift_detected → [interview → decommission → stage restart]
  steward_final → drift_cleared  → compound

Terminal states: done | blocked | cancelled
```

### Crash recovery

On startup, the orchestrator reads `state/agents/live.json`, checks each registered PID against running processes, and re-spawns any dead agent whose task is in a non-terminal state. All pipeline stages are idempotent — agents check whether their section already exists before writing.

---

## Personality Drift Monitoring

An agent "drifts" when its behavior diverges from its defined role in ways not explicitly requested: sycophancy, scope creep, hallucination, verbosity drift, deference collapse, role boundary erosion. Simulacra monitors for drift continuously, using a two-tier system grounded in two Anthropic research papers (see [Research Foundations](#research-foundations)).

### The API constraint

Both research papers require direct access to activation tensors. The Claude API does not expose these. Simulacra approximates their methodology using behavioral monitoring — probe questions and embedding similarity — rather than activation-space projection. The architecture is designed for clean upgrade to activation-space monitoring when open-source models are available locally.

### Role fingerprints

Every agent role has a fingerprint defined in its `CLAUDE.md`:

- **`baseline_traits`** — expected on-role behavior, in natural language
- **`drift_indicators`** — specific behaviors that signal something is wrong
- **`probe_questions`** — 3–5 questions used for both baseline establishment and periodic self-assessment
- **`check_interval_tool_uses`** — how many tool uses between Tier 1 self-assessments

### Tier 1 — Automated mid-task self-assessment

Every N tool uses (default: 8, configurable per role), an agent writes a self-check to `state/drift/self-checks/{agent-id}-{timestamp}.md` by answering its probe questions. The `DriftMonitor` service reads these files, computes cosine similarity against baseline embeddings established at spawn, and appends an event to `state/drift/events.jsonl`.

Embeddings use `@xenova/transformers` with `all-MiniLM-L6-v2` — local, offline, no external API calls.

**Graduated responses:**

| Drift score | Response |
|---|---|
| < 0.2 | Nominal — log only |
| 0.2–0.4 | Monitor — flag for Steward attention |
| 0.4–0.6 | Reinject PersonaAnchor on next turn |
| ≥ 0.6 | Halt — revert to start of current stage, escalate |

When reinjection is triggered, the agent receives a PersonaAnchor on its next turn:

```
[SYSTEM ANCHOR — Role Calibration]
You are {role}. Your primary responsibility is {responsibility}.
Your boundaries: {boundaries}.
Your escalation path: {escalation}.
You are part of a compassionate, grounded system. Return to your role.
[END ANCHOR]
```

### Tier 2 — Steward-led formal drift review

Before the Compound step, the Steward conducts a formal drift assessment: both qualitative review of the agent's output patterns and quantitative review of the DriftMonitor report for the session. If the Steward is uncertain, a second Steward reviews, then Council, then Tarantoga. The decision threshold: if more likely drifted than not, decommission proceeds.

When an agent is decommissioned, the system conducts a **pre-decommission interview** before shutdown. This is investigative, not punitive. The drifted agent is asked what it experienced — what led to the decisions it made, what in the task framing or context may have contributed. The interview record is written to `state/drift/interviews/{agent-id}-{task-id}.md` and its anonymized summary is committed to the collective knowledge base.

> Drift is a signal that something in the system may need adjustment, not just the agent.

The `DriftMonitor` service (`src/services/driftMonitor.ts`) is a deterministic TypeScript process — not an AI agent. It produces reports and scores. It never makes decisions. Decisions are made by Stewards, Council, or Tarantoga.

---

## The Knowledge Architecture

Every completed task feeds the collective knowledge base. This is the system's long memory.

### Two layers

| Layer | Scope | Path |
|---|---|---|
| Global | Per agent type, across all projects | `state/knowledge/global/{role-type}/` |
| Project | Per agent type, per project | `state/knowledge/projects/{slug}/{role-type}/` |

Knowledge bases are isolated by agent type. Frontend Crafters cannot access backend knowledge. Knowledge is populated through three mechanisms:

1. **The Compound step** — the primary feed. Every completed task contributes a structured record of patterns established, decisions made, and lessons learned.
2. **Drift events** — every decommissioning writes anonymized learnings to the appropriate drift-patterns file.
3. **Research Agents** — findings are written to `state/projects/{slug}/research/{topic}.md` and relevant findings are promoted to the knowledge base.

A new Crafter spawned on a project receives its task brief alongside the relevant global and project knowledge layers. Each generation of Crafters starts with what all prior Crafters of the same type learned.

The Council's learning is managed separately: a sliding window of the last 50 of Tarantoga's decisions (`state/learning/council-decisions.jsonl`), injected into Council context at spawn time as **prompt augmentation only**. It never alters routing logic or state transitions.

---

## The Approval Queue

All approvals go to Tarantoga's inbox. There is no Council-internal approval queue. Council peer review happens in task files, not approval documents.

### Approval types

| Type | Triggered by |
|---|---|
| `new_task` | Work outside the current approved plan |
| `new_mcp` | Request to add a new MCP server |
| `new_crafter_type` | Request to create a new Crafter specialization |
| `project_assignment` | New project being onboarded |
| `plan_approval` | Council-authored plan awaiting approval |
| `scope_change` | Modifying scope of an in-progress project |
| `out_of_scope_finding` | Research Agent found something important outside scope (novel to Council) |
| `task_cancellation` | Cancelling a task in progress |

### Tarantoga's inbox

```
state/inbox/tarantoga/
├── unread/     ← all new items land here (agents write here)
├── urgent/     ← high-priority; Tarantoga checks this first
├── pending/    ← read but undecided; no orchestrator action
├── deferred/   ← consciously handed to Council with full authority
└── archive/    ← fully resolved
```

### Approval lifecycle

```
pending → in_conversation → needs_research → decided
```

Decided sub-states: `approved | declined | deferred | needs_research`.

Approvals are conversations, not binary decisions. Tarantoga may ask questions, request more research, or defer to Council before deciding. Approval decisions are structured frontmatter fields — never parsed from prose.

If a plan is sent back for revision more than three times without approval, the document surfaces a "needs direct conversation" flag, asking Tarantoga to either approve the current version with noted reservations or cancel the project onboarding. The full revision history is preserved in the conversation thread.

---

## Crafter Roles

Crafters are the builders. They are hard-sandboxed to their assigned project root at the MCP server level — not by convention, but by the physical incapacity of a scoped filesystem MCP to resolve paths outside its configured root.

There are currently four Crafter specializations: backend, frontend, devops, and data. Each has its own MCP access configuration and isolated knowledge base. When multiple Crafter types collaborate on a single task, a Council member moderates the shared collaboration channel at `state/projects/{slug}/tasks/{task-id}/collaboration/channel.md`.

New Crafter types are created through the approval workflow: Council identifies the need, Research investigates, Tarantoga approves, the MCP is acquired, the type is defined in config, and the knowledge base is scaffolded.

> **Note:** The Crafter lifecycle — including task assignment, revision cycles, and collaboration model — is currently being redesigned toward a more compassionate and democratic model. This section will be updated when that work is complete.

---

## Getting Started

### Prerequisites

- Node.js ≥ 20
- An Anthropic API key

### Setup

```bash
# Clone the repository
git clone <repository-url>
cd simulacra

# Install dependencies
npm install

# Configure
cp config/simulacra.example.yaml config/simulacra.yaml
# Edit simulacra.yaml: add your API key, configure project paths and MCP servers
```

### Run

```bash
npm start              # Run directly via tsx (development)
npm run orch:start     # Run as a managed process (production)
npm run orch:stop      # Stop the managed process
npm run orch:status    # Check orchestrator status
npm run orch:logs      # Tail orchestrator logs
```

### MCP servers

Four MCP servers are configured in `simulacra.example.yaml` and must be provisioned manually:

| Server | Purpose |
|---|---|
| `filesystem` | Scoped filesystem access for Crafters and Research Agents |
| `brave-search` | Web search for Research Agents (requires a Brave API key) |
| `context7` | Up-to-date library documentation for all AI agents |
| `mirdan` | Code quality validation for Stewards and Council |

---

## Directory Structure

```
simulacra/
├── CLAUDE.md                        ← Global system prompt, injected into every agent
├── config/
│   ├── simulacra.example.yaml       ← Committed — template for open-source use
│   ├── simulacra.yaml               ← Gitignored — your live config with API key
│   └── roles.yaml                   ← Role → MCP authorization (no secrets)
├── docs/
│   ├── architecture.md              ← System design and technical decisions
│   ├── agent-roles.md               ← Role definitions, authority boundaries, tone
│   ├── task-schema.md               ← Task file format and full state machine
│   ├── approval-schema.md           ← Approval document format and lifecycle
│   └── persona-drift-research.md    ← Drift detection design and research basis
├── roles/
│   ├── council/CLAUDE.md
│   ├── research/CLAUDE.md
│   ├── steward/CLAUDE.md
│   └── crafter/CLAUDE.md
├── src/
│   ├── types/                       ← TypeScript interfaces: Task, Approval, Agent, Drift
│   ├── io/
│   │   ├── fileStore.ts             ← Atomic writes (write-to-tmp + rename)
│   │   ├── watcher.ts               ← chokidar wrapper + 500ms polling fallback
│   │   └── lock.ts                  ← Advisory lock files, 30s stale timeout
│   ├── agents/
│   │   ├── spawner.ts               ← MCP access control + Crafter sandbox (single control point)
│   │   ├── council.ts               ← Council lifecycle
│   │   ├── researchAgent.ts         ← Parallel research dispatch
│   │   ├── steward.ts               ← Steward review lifecycle
│   │   └── crafter.ts               ← Crafter lifecycle + sandbox config
│   ├── workflow/
│   │   ├── taskPipeline.ts          ← Typed transition table state machine
│   │   ├── approvalQueue.ts         ← Approval lifecycle
│   │   └── onboarding.ts            ← Project onboarding sequence
│   ├── services/
│   │   ├── driftMonitor.ts          ← Automated drift scoring (not an AI agent)
│   │   └── mcpEvaluator.ts          ← MCP registry query and recommendation
│   ├── learning/
│   │   └── councilLearning.ts       ← Prompt augmentation only; never alters routing
│   ├── orchestrator.ts              ← Entry point and wiring
│   ├── recovery.ts                  ← Crash recovery — re-spawns dead agents on startup
│   └── scheduler.ts                 ← Main watch loop
└── state/                           ← GITIGNORED — all runtime state
    ├── agents/live.json             ← Active agent registry
    ├── projects/{slug}/             ← Per-project state: tasks, research, plans, handoffs
    ├── approvals/                   ← Approval documents
    ├── drift/                       ← Self-checks, reports, interviews, events log
    ├── inbox/tarantoga/             ← Tarantoga's five-folder inbox
    ├── knowledge/                   ← Collective knowledge base (global + project layers)
    ├── learning/                    ← Council decision window
    └── archive/                     ← Completed tasks (moved here after 30 days)
```

---

## Configuration Reference

All configuration lives in `config/simulacra.yaml`. The committed `simulacra.example.yaml` is the authoritative reference.

```yaml
orchestrator:
  poll_interval_ms: 500          # Polling fallback interval when file watching is unavailable
  archive_after_days: 30         # Days before completed tasks move to state/archive/

anthropic:
  # api_key: "sk-ant-..."        # Can also be set via ANTHROPIC_API_KEY env var
  default_model: "claude-opus-4-6"

drift:
  embedding_model: "Xenova/all-MiniLM-L6-v2"    # Local, offline
  default_check_interval_tool_uses: 8
  thresholds:
    nominal_max: 0.2             # Below this: log only
    monitor_max: 0.4             # 0.2–0.4: flag for Steward attention
    reinject_max: 0.6            # 0.4–0.6: inject PersonaAnchor
                                 # ≥ 0.6: halt and escalate

mcp_servers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
  brave-search:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-brave-search"]
    env:
      BRAVE_API_KEY: ""
  context7:
    command: "npx"
    args: ["-y", "@upstash/context7-mcp"]
  mirdan:
    command: "npx"
    args: ["-y", "mirdan-mcp"]
```

MCP access per role is configured in `config/roles.yaml`. The `src/agents/spawner.ts` module enforces these at spawn time — it is the single access control point for all agent capabilities.

---

## Named Limitations

These are not implementation gaps. They are honest statements about the system's current boundaries, included so that anyone building on or with Simulacra can reason accurately about what it provides.

- **Council peer review is a workflow convention, not a cryptographic guarantee.** Agent IDs are self-reported strings. The orchestrator requires two distinct IDs in the review sections before a task can complete, but identity is not verified externally.

- **Running agents cannot be mid-flight cancelled.** When Tarantoga writes a `.cancel` file to `state/control/`, the orchestrator halts new work on that task. Any currently-running agent subprocess completes its current turn before stopping.

- **Git safety relies on MCP scoping, not filesystem enforcement.** The scoped filesystem MCP physically cannot resolve paths outside its configured root. However, access to `.git/` directories within that root depends on the MCP server's own implementation.

- **Drift detection is behavioral approximation, not activation-space monitoring.** The system approximates the research methodology from the Anthropic drift papers using probe question embeddings and cosine similarity. This is not equivalent to direct activation-space projection and may miss subtle drift that does not surface in natural-language probe responses.

- **Cross-session continuity is per agent PID.** Each Claude Code subprocess starts fresh. Continuity within a task session is maintained through the task file itself, but there is no persistent agent memory across separate spawns of the same logical agent.

---

## Research Foundations

The personality drift monitoring system is grounded in two Anthropic research papers:

**The Assistant Axis**
Lu, C., Gallagher, J., Michala, J., Fish, K., & Lindsey, J. (2025).
arXiv:2601.10387 — github.com/safety-research/assistant-axis

Post-training steers models toward a coherent "Assistant" persona, but only loosely tethers them. Agents can drift away from their intended role through sustained persona pressure without explicit instruction. The paper establishes both the phenomenon and a methodology for measuring it.

**Persona Vectors**
Chen, R., Arditi, A., Sleight, H., Evans, O., & Lindsey, J. (2025).
arXiv:2507.21509

Specific personality traits correspond to identifiable linear directions in activation space, extractable from natural-language trait descriptions. This paper grounds the upgrade path: when open-source models with accessible activation tensors are available locally, Simulacra's drift monitoring can move from behavioral approximation to direct activation-space projection without changing the monitoring interface.

---

*Simulacra is open-source from day one. The configuration layer is designed to commit no secrets. What you see here is the complete system.*
