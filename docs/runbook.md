# Simulacra — Runbook

Operational reference for running and working with the Simulacra orchestration system.
Update this document as the system evolves.

---

## Prerequisites

- **Node.js** >= 20
- **Claude Code CLI** installed and authenticated (`claude` available on PATH)
- **Anthropic API key** set in your environment: `ANTHROPIC_API_KEY=sk-ant-...`
- Dependencies installed: `npm install`

---

## First-Time Setup

### 1. Create your config file

```bash
cp config/simulacra.example.yaml config/simulacra.yaml
```

Edit `config/simulacra.yaml`:
- Set any MCP API keys you want (e.g. `BRAVE_API_KEY` for web search)
- The defaults for everything else are fine to start

### 2. Verify your API key is working

```bash
npm run check-api
```

### 3. Ensure state directories exist

The orchestrator creates most directories automatically, but the base ones need to exist:

```bash
mkdir -p state/tasks state/approvals state/projects state/agents state/knowledge/global state/knowledge/projects state/drift/self-checks state/drift/interviews logs
```

---

## Starting the Orchestrator

### Foreground (interactive — you see the console live)

```bash
npm start
```

The orchestrator prints timestamped log lines and prompts you directly in the terminal when an approval needs your decision.

### Background (persistent, survives terminal close)

```bash
npm run orch:start     # start in background, logs → logs/orchestrator.log
npm run orch:stop      # stop
npm run orch:restart   # restart
npm run orch:status    # check if running
npm run orch:logs      # tail the log file
```

> The background runner uses a PID file at `.orch.pid`. If the process dies unexpectedly, delete the stale file and re-run `orch:start`.

---

## Onboarding a New Project

The new project kickoff flow is fully automated once you onboard. Here is the complete sequence:

### Step 1 — Register the project (orchestrator does NOT need to be running)

```bash
npx tsx scripts/onboard.ts "<Project Name>" <absolute-path-to-project> <crafter-types>
```

**Crafter types** are comma-separated. Valid values: `frontend`, `backend`, `devops`, `data`.

Example:
```bash
npx tsx scripts/onboard.ts "Prosthetic Memory" C:/Users/gz/Desktop/Programming/prosthetic-memory-desktop frontend,backend
```

This:
- Writes the project entry to `state/projects/registry.json`
- Creates a `project_assignment` approval in `state/approvals/`
- Prints the approval ID

**Your project must have a `docs/implementation-plan.md`** before the kickoff Council runs. The Council reads this file to understand what needs to be built.

### Step 2 — Start the orchestrator

```bash
npm start
```

The approval console will immediately prompt you for the `project_assignment` approval.

### Step 3 — Approve the project assignment

The console will display:
```
[APPROVAL REQUEST]
  Type:        project_assignment
  ...
[y] approve  [n] decline  [d] defer  [p] pending
Decision:
```

Press `y` + Enter.

**What happens automatically from here:**

| Step | What | Where |
|------|------|-------|
| 1 | Project status → `kickoff_pending` | `state/projects/registry.json` |
| 2 | Next scheduler cycle detects it → `kickoff_in_progress` | registry |
| 3 | Council kickoff agent spawns | `logs/council-kickoff-*.log` |
| 4 | Council reads `docs/implementation-plan.md`, scans code, creates task files | `state/tasks/{project}/` |
| 5 | Council creates a `plan_approval` in approvals queue | `state/approvals/` |
| 6 | Console prompts you to review the plan | terminal |

### Step 4 — Review and approve the plan

The console will show a `plan_approval` summarising:
- Which implementation plan phases are DONE / PARTIAL / NOT STARTED
- The proposed task list with priorities
- Any ambiguities the Council flagged

Press `y` to approve (tasks flip to `pending`, project becomes `active`, scheduler assigns crafters) or `n` to decline (tasks cancelled, project requeues for another kickoff attempt).

---

## Console Approval Keys

Every approval that needs your input is prompted in the terminal:

| Key | Action |
|-----|--------|
| `y` | Approve |
| `n` | Decline |
| `d` | Defer (come back later) |
| `p` | Mark `in_conversation` — suppresses re-prompting until you reopen it manually |

Some approval types are **auto-approved** without prompting: `task_cancellation`.

---

## Monitoring What's Happening

### Live console output

The orchestrator prints a timestamped line for every significant event:
- `[Agent] SPAWN` — a new agent subprocess started
- `[Agent] DONE` — an agent finished (includes turn count and cost)
- `[Agent] FAIL` — an agent exited non-zero
- `[Pipeline]` — a task state transition fired
- `[Scheduler]` — task assignment or orphan reset
- `[ApprovalConsole]` — approval decision recorded

### Agent logs

Every spawned agent writes its full Claude Code JSON output to:
```
logs/{agent-id}.log
```

Useful when an agent fails — check the log for what it was doing.

### Task files

All task state lives in `state/tasks/{project-slug}/`. Read any `.md` file there to see the full history of a task — crafter work, steward review, council decisions, all in one place.

### Project registry

```
state/projects/registry.json
```

Shows every project and its current status.

---

## Task Status Lifecycle

```
blocked → pending → assigned → in_progress → steward_review
       → steward_final → compound → council_review
       → council_peer_review → done
```

- `blocked` — created by Council kickoff, waiting for plan approval
- `pending` — ready to be assigned (plan approved, dependencies met)
- `assigned` — scheduler picked it up, crafter spawning
- `in_progress` — crafter is working
- `steward_review` / `steward_final` — steward reviewing crafter output
- `compound` — Council conducting Compound step interview
- `council_review` / `council_peer_review` — two Council members reviewing
- `done` — complete

Side states: `research_pending`, `research_review` (Council commissioned research), `crafter_revision` (steward sent back for fixes), `drift_detected`, `cancelled`.

---

## Project Status Lifecycle

```
onboarding_requested → kickoff_pending → kickoff_in_progress → active → archived
                    ↘ declined
```

---

## Manually Manipulating State

Sometimes you need to unstick things. All state is plain files — edit directly.

### Reset a stuck task to pending

Edit the task file's frontmatter:
```yaml
status: pending
assigned_crafter: null
updated_at: <current ISO timestamp>
```

### Re-run a kickoff (e.g. Council failed)

Edit `state/projects/registry.json`:
```json
"status": "kickoff_pending"
```
The next scheduler cycle will detect it and spawn a new Council kickoff agent.

### Cancel a task

Edit the task file:
```yaml
status: cancelled
```

---

## Utility Commands

```bash
npm run build        # compile TypeScript → dist/
npm run typecheck    # type-check without emitting
npm run lint         # ESLint
npm run test         # run tests (watch mode)
npm run test:run     # run tests once
```

---

## Common Issues

**Orchestrator exits immediately**
- Check `config/simulacra.yaml` exists (copy from `simulacra.example.yaml`)
- Check `ANTHROPIC_API_KEY` is set

**Agent spawned but did nothing / failed immediately**
- Check `logs/{agent-id}.log` — the full Claude Code output is there
- Verify `claude` is on PATH: `claude --version`
- Verify the API key has quota

**Approval console not prompting**
- The console only prompts when `stdin` is a TTY. If you're running in background mode (`orch:start`), approvals won't be prompted — switch to foreground (`npm start`) when you need to make decisions.

**Kickoff Council ran but created no tasks**
- The Council requires `docs/implementation-plan.md` in the project directory. Create it and reset the project status to `kickoff_pending`.

**Stale `.orch.pid` file after a crash**
```bash
rm .orch.pid
npm run orch:start
```
