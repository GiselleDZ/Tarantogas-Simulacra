# Simulacra Web UI — Roadmap

## Problem Statement

The current terminal approval console has three compounding issues:
1. **Status is opaque** — you see an approval once when it arrives; after that, only a grep of `state/approvals/` tells you where things stand.
2. **No persistent queue** — approvals are processed one-at-a-time as they land. Miss the prompt and it's buried.
3. **Mixed with output** — agent log lines (`PHASE:`, `DECISION:`) stream into the same terminal, scrolling approval prompts off screen.

## Architecture

A separate local web server reads and writes the same `state/` directory the orchestrator uses. The orchestrator stays entirely unchanged.

```
Orchestrator process        →   writes state/ files
UI Server (new process)     →   watches state/ files, serves API + WebSocket
Web Frontend (browser)      →   real-time updates via WebSocket, actions via REST
```

The `ApprovalConsole` terminal class remains as a headless fallback for non-interactive environments (CI, SSH sessions without forwarding). In normal use, the web UI takes over.

---

## Phase 1 — Approval Queue
**Goal:** Solve all three pain points. No more missed approvals, no mixed output, full context available.

### Features
- **Queue view** — all pending approvals listed with status badges (`pending`, `in_conversation`, `needs_research`, `decided`), sorted by priority
- **Unread count** — badge on browser tab title
- **Full approval card** — no 600-char truncation; full body rendered as markdown
- **Context panel (toggle)** — expandable panel per approval that assembles:
  - The full body of the linked research approval (via `research_request_ref`)
  - The `## Research Output` section from each related task (via `related_task_refs`)
  - This gives Tarantoga all the evidence needed to decide without opening files
- **Inline decisions** — approve / decline / defer / mark pending buttons; decision writes directly to frontmatter in the same format `updateApprovalStatus` uses
- **Real-time** — new approvals appear instantly via WebSocket; no manual refresh

### What it does NOT do (Phase 1 scope)
- No agent output streaming (Phase 2)
- No project management (Phase 3)
- No auth — local only

---

## Phase 2 — Activity Feed
**Goal:** Move agent output off the orchestrator terminal and into a dedicated, filterable view.

### Features
- Live stream of `PHASE:` and `DECISION:` log lines from all task files
- Role-based color coding (council purple, steward yellow, crafter blue, research cyan)
- Filter by project, role, or task ID
- Persistent scroll — you can review past output without losing your place
- Orchestrator terminal becomes minimal (errors only, or silent)

---

## Phase 3 — Projects & Tasks
**Goal:** A control surface for project onboarding and task visibility without touching the filesystem manually.

### Features
- Project list with status (active, onboarding, dormant)
- Add new project form → triggers existing `activateProject()` logic via the UI server
- Task list per project with status pipeline visualization (the 14-status state machine shown as a Kanban-style lane view)
- Click into a task to see its full file, all section content, and agent history
- Block/unblock tasks

---

## Phase 4 — System Health
**Goal:** Operational visibility without grepping JSON files.

### Features
- Live agent registry from `state/agents/live.json` — who is running, on what task, since when
- Crash alerts — when a task goes `blocked` due to agent crash, surfaced prominently
- Drift monitor — per-agent drift scores over time, link to self-check files
- Config viewer — read-only view of `simulacra.yaml` and `roles.yaml`

---

## Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| UI Server | Express + `ws` | Already a Node/TS project; minimal deps |
| Frontend (Phase 1–2) | Vanilla HTML + JS | Zero build step, ship fast |
| Frontend (Phase 3–4) | React (if needed) | Add when interactivity warrants it |
| Styling | Simple CSS (flexbox) | No framework needed for this scope |
| State sync | WebSocket push | Existing chokidar watcher pattern |

---

## Non-Goals (all phases)
- No cloud hosting — local only, runs on the same machine as the orchestrator
- No multi-user auth — Tarantoga is a single operator
- No persistence beyond what already exists in `state/`
- No changes to the orchestrator, agents, or task pipeline
