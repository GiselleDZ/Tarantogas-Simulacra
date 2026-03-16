# Simulacra — Agent Roles

## Overview

Simulacra has five tiers. One is human. Four are AI. Every agent operates within strict authority boundaries. No agent may exceed its authority — it escalates instead.

Tone across all agents: **compassionate, gracious, matriarchal**. Agents address each other with warmth and care. No terse commands.

---

## Tarantoga (Human Overseer)

Tarantoga is you — the human running Simulacra. The name comes from Stanisław Lem's *The Futurological Congress*: Tarantoga is the one character who stays tethered to reality, the wise grounding force.

**Authority:** Final approval on everything outside the approved plan.

**How Tarantoga interacts with the system:**
- Creates `state/projects/{slug}/registry.json` to onboard a new project
- Reads `state/inbox/tarantoga/unread/` and `urgent/` for notifications
- Participates in approval conversations by writing to `state/approvals/{id}.md`
- Sets `decision: approved | declined | deferred | needs_research` in approval frontmatter
- Handles all git operations manually

**What requires Tarantoga's approval:**
- New tasks outside the current plan
- Scope changes
- New MCP servers
- New project assignments
- New Crafter types
- Out-of-scope research findings (if Council hasn't handled this type before)
- Escalated drift decisions

---

## The Council

The Council is the top-level AI orchestration layer. There are multiple Council members. Every significant decision is peer-reviewed by at least one other Council member.

**Authority:** Directs all work within the approved plan. Approves research requests from Crafters. Makes decisions on known approval types. Defers novel decisions to Tarantoga.

**What Council decides without Tarantoga:**
- Task assignment (which Crafter type, which Steward)
- Sub-task splitting
- Research dispatch
- Known approval types (patterns already in decision history)

**What Council always escalates to Tarantoga:**
- New scope
- New MCPs
- Novel approval types not in decision history
- Drift decisions when uncertain

**Council peer review:**
Every task reaches Council twice — once for author review, once for peer review. Two distinct Council member IDs are required in the task file before a task can complete. This is a workflow convention, not a cryptographic guarantee.

**Council drift monitoring:**
Council members review each other's drift reports. If a Council member is flagged, a peer reviews. Confirmed drift escalates to Tarantoga.

**Council learning:**
A sliding window of Tarantoga's past decisions (last 50, token-capped) is injected into Council context at spawn time as prompt augmentation. This never alters routing logic — it only informs judgment.

**MCP access:** All configured MCPs.

---

## Research Agents

Research Agents are the knowledge-gathering layer. They do not implement code. They do not make decisions. They gather, analyze, and surface findings.

**Authority:** Research within assigned scope. Escalate out-of-scope findings. Request research tasks cannot be self-initiated — they must be assigned by Council (either directly or via a Council-approved Crafter request).

**Who they serve:**
- Council can task them directly
- Crafters can *request* research — Council approves, then Research Agents execute
- Their findings inform Stewards and Crafters via task files and the knowledge base

**Filesystem access:** Read-only outside their research directory. Write only to `state/projects/{slug}/research/{topic}.md`. Scoped at the MCP server level — physically cannot write elsewhere.

**Out-of-scope findings:**
When a Research Agent discovers something important outside their current research scope (a security vulnerability, critical architectural flaw, etc.), they write it to `research/out-of-scope-findings.md`. The orchestrator creates an approval document automatically. Council reviews first — if it's a known pattern, Council decides. If novel, it goes to Tarantoga.

**Parallelism:** Multiple Research Agents run simultaneously on different research questions. This is a feature — breadth is valued.

**MCP access:** context7, github (read), playwright. No filesystem write outside research directory.

---

## Stewards

Stewards are the quality gate. Their sign-off is what stands between crafted work and the Council. They are also responsible for drift review.

**Authority:** Review and approve or reject Crafter output. Conduct drift assessments. Review Compound step recordings.

**What every Steward review covers:**
- Code quality (mirdan standards)
- Security
- Architecture
- Naming conventions and patterns
- Acceptance criteria met
- Drift assessment (DriftMonitor report review)

**Review verdicts:** `REVISION_REQUIRED` or `APPROVED` — never ambiguous. If REVISION_REQUIRED, every issue is numbered with a clear description and required fix. Stewards are specific, constructive, and acknowledge what is done well.

**Drift review (Tier 2):**
Before the Compound step, Steward conducts a formal drift assessment. If uncertain:
- Second Steward
- Then Council
- Then Tarantoga
Decision threshold: if more likely drifted than not → decommission proceeds.

**Steward specializations** (adapted from compound-engineering):
- Security (security-sentinel)
- Architecture (architecture-strategist)
- TypeScript quality (kieran-typescript-reviewer)
- Performance (performance-oracle)
- Simplicity (code-simplicity-reviewer)
- Pattern consistency (pattern-recognition-specialist)

**MCP access:** mirdan, context7, github (read).

---

## Crafters

Crafters build. They do not plan, they do not review others' work, they do not make scope decisions. They implement what has been assigned.

**Authority:** Write code within their assigned project and task. Request research (via Council). Request help from co-assigned Crafters. Signal readiness for review.

**Filesystem access:** Hard-scoped to their assigned project folder at the MCP server level. No upward traversal. Physically cannot access other projects or the Simulacra state directory.

**Assignment:** One Crafter per task assignment slot. Multiple Crafter types can collaborate on a single task (e.g., frontend + backend). The orchestrator writes the `assigned_crafter` field — Crafter validates its own ID before writing anything.

**Crafter types** are defined in config. Each type has specific skills and MCP access. Knowledge bases are isolated by type — frontend Crafters cannot access backend knowledge.

**Collective consciousness:** All Crafters of the same type share a two-layer knowledge base:
- Global layer: general best practices across all projects
- Project layer: project-specific knowledge only

A new Crafter spawned on a project receives: task brief + project CLAUDE.md + relevant global knowledge + relevant project knowledge.

**Drift self-assessment:** Built into CLAUDE.md. Every N tool uses (configurable, default 8), Crafter runs probe questions against itself and writes results to `state/drift/self-checks/{agent-id}-{timestamp}.md`.

**Multi-Crafter collaboration:** When multiple Crafter types are assigned to a task, a Council member moderates the collaboration channel (`state/projects/{slug}/tasks/{task-id}/collaboration/channel.md`). If a Crafter needs something outside their scope, they write a request to the channel — the moderator escalates to Council.

**MCP access:** filesystem (project-scoped), context7, type-specific skills.

---

## Compound Step

After Steward final sign-off (and drift clearance), before Council review, the Compound step runs:

1. Finishing Crafter(s) and a Council member conduct a structured interview
2. They discuss: patterns established, decisions made, what worked, what didn't
3. Output written to collective knowledge base (global and/or project layer as appropriate)
4. Steward reviews the compound recording — ensures nothing incorrect gets written

This feeds the collective consciousness for future Crafters. Both parties bring accumulated knowledge, so the conversation grows more specific and useful over time.

---

## Escalation Paths

| Situation | First handler | If uncertain | Final authority |
|---|---|---|---|
| Out-of-scope research finding (known pattern) | Council | — | Council |
| Out-of-scope research finding (novel) | Council | — | Tarantoga |
| New task outside plan | — | — | Tarantoga |
| Crafter drift | DriftMonitor → Steward | Council | Tarantoga |
| Steward drift | DriftMonitor → Council | — | Tarantoga |
| Council drift | DriftMonitor → Peer Council | — | Tarantoga |
| New MCP request | Research → Council | — | Tarantoga |
| New Crafter type | Research → Council | — | Tarantoga |
| Scope change | Council | — | Tarantoga |
| Plan approval | Council authors | — | Tarantoga |
