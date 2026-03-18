# Phase 3 Implementation Plan — Projects & Tasks

## Overview

Two concerns in one plan:

1. **Project list** — shows all projects from `state/projects/registry.json` with status, crafter types, and a form to onboard new ones.
2. **Task pipeline** — Kanban view of all tasks for the selected project, sourced from `state/tasks/{slug}/*.md`. Tasks update in real time via WebSocket. Click a task to see its full content. Block/unblock from the detail panel.

---

## Data Model

### Projects — `state/projects/registry.json`

```typescript
interface ProjectRegistry {
  slug: string;
  name: string;
  path: string;          // absolute path to repo
  status: ProjectStatus; // see below
  created_at: string;
  updated_at: string;
  crafter_types: string[];
  active_task_ids: string[];
  kickoff_plan_approval_ref?: string | null;
}

type ProjectStatus =
  | "onboarding_requested" | "onboarding_in_progress"
  | "kickoff_pending"      | "kickoff_in_progress"
  | "active" | "declined"  | "archived";
```

### Tasks — `state/tasks/{slug}/*.md`

```typescript
interface TaskFrontmatter {
  id: string; schema_version: number; project: string; title: string;
  status: TaskStatus;     // 15 possible values (see task.ts)
  created_at: string; updated_at: string;
  assigned_crafter: string | null;  assigned_steward: string | null;
  assigned_council_author: string | null; assigned_council_peer: string | null;
  priority: "low" | "medium" | "high" | "critical";
  crafter_type: string;  blocked_by: string[];
  // ... others
}
```

### `TaskRecord` (new interface, mirrors `ApprovalRecord`):
```typescript
export interface TaskRecord {
  readonly frontmatter: TaskFrontmatter;
  readonly body: string;
  readonly filePath: string;
}
```

---

## Kanban Lane Groups

| Lane | Statuses |
|---|---|
| Queued | `pending`, `blocked` |
| Research | `research_pending`, `research_review` |
| In Progress | `assigned`, `in_progress`, `crafter_revision` |
| Review | `steward_review`, `steward_final`, `compound`, `council_review`, `council_peer_review`, `drift_detected`, `drift_cleared` |
| Done | `done`, `cancelled` |

---

## Implementation Order

1. `src/ui/taskWatcher.ts` — no deps on other new files
2. `src/ui/routes/projects.ts` — depends on taskWatcher + onboarding.ts
3. `src/ui/server.ts` — wire in taskWatcher + project routes + new WS message
4. `public/style.css` — project sidebar + pipeline lane + task card + detail panel styles
5. `public/index.html` — Projects tab pane structure
6. `public/app.js` — projects tab logic

---

## Part 1 — Backend

### `src/ui/taskWatcher.ts` (new)

Responsibilities:
- Watch `state/tasks/**/*.md` (same pattern as orchestrator and ActivityWatcher)
- Parse full `TaskFrontmatter` + body on every add/change
- Maintain `Map<string, TaskRecord>` keyed by `frontmatter.id`
- Call `onUpdate(task: TaskRecord)` callback on every change (for WS broadcast)
- Handle `unlink` by removing from map

Public API:
```typescript
export interface TaskRecord {
  readonly frontmatter: TaskFrontmatter;
  readonly body: string;
  readonly filePath: string;
}

class TaskWatcher {
  constructor(onUpdate: (task: TaskRecord) => void)
  getAll(): TaskRecord[]
  getByProject(slug: string): TaskRecord[]
  get(id: string): TaskRecord | undefined
  async close(): Promise<void>
}
```

Pattern to follow: identical to `src/ui/approvalWatcher.ts` — Watcher.create + readMarkdownFile + Map.

---

### `src/ui/routes/projects.ts` (new)

```
GET  /api/projects                              → ProjectRegistry[] (all, sorted by name)
POST /api/projects                              → onboardProject() → { slug, approvalId }
GET  /api/projects/:slug/tasks                  → TaskRecord[] for project (from taskWatcher)
GET  /api/projects/:slug/tasks/:taskId          → single TaskRecord
POST /api/projects/:slug/tasks/:taskId/block    → set status "blocked", clear assigned_crafter
POST /api/projects/:slug/tasks/:taskId/unblock  → set status "pending"
```

**POST /api/projects** body (Zod-validated):
```typescript
const OnboardSchema = z.object({
  name: z.string().min(1).max(80),
  path: z.string().min(1),
  crafterTypes: z.array(z.string().min(1)).min(1),
});
```
Calls `onboardProject({ name, path, crafterTypes, requestedBy: "tarantoga" })`.

**POST .../block** and **POST .../unblock**:
- Get task via `taskWatcher.get(taskId)` — returns 404 if not found
- Read the file (has filePath), use `FileLock` + `writeMarkdownFile`
- Block: `status: "blocked"`, `assigned_crafter: null`, `updated_at: now`
- Unblock: `status: "pending"`, `updated_at: now`

Slug validation: `isValidSlug(s)` — `typeof s === "string" && /^[a-z0-9-]+$/.test(s)`
Task ID validation: `isValidTaskId(s)` — `typeof s === "string" && s.length > 0 && !s.includes("/")`

---

### `src/ui/server.ts` (modified)

Three additions:
1. Import `TaskWatcher` + `createProjectRoutes`
2. Add `{ type: "task_update"; task: TaskRecord }` to `WsMessage` union
3. Create `taskWatcher` and broadcast on updates
4. Mount `/api/projects` routes
5. On new WS connection, do **not** send a task snapshot (too large) — frontend fetches per-project via HTTP

Updated `WsMessage` union:
```typescript
type WsMessage =
  | { type: "snapshot";           approvals: ApprovalRecord[] }
  | { type: "approval_update";    approval: ApprovalRecord }
  | { type: "activity_snapshot";  events: ActivityEvent[] }
  | { type: "activity_lines";     events: ActivityEvent[] }
  | { type: "task_update";        task: TaskRecord };
```

---

## Part 2 — Frontend

### HTML structure (Projects pane)

Replace the current `<div class="coming-soon">` placeholder:

```html
<div id="tab-projects" class="tab-pane" hidden>
  <div id="projects-sidebar">
    <div id="add-project-toggle" class="sidebar-section-header">
      <button class="sidebar-toggle-btn" id="add-project-btn">+ New Project</button>
    </div>
    <form id="add-project-form" hidden>
      <div class="form-field">
        <label class="form-label">Name</label>
        <input type="text" id="proj-name" class="form-input" placeholder="My Project" required>
      </div>
      <div class="form-field">
        <label class="form-label">Path</label>
        <input type="text" id="proj-path" class="form-input" placeholder="/absolute/path/to/repo" required>
      </div>
      <div class="form-field">
        <label class="form-label">Crafter Types</label>
        <input type="text" id="proj-crafters" class="form-input" placeholder="frontend, backend" required>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-approve" style="font-size:11px;padding:5px 14px">Submit</button>
        <button type="button" id="add-project-cancel" class="btn btn-defer" style="font-size:11px;padding:5px 14px">Cancel</button>
      </div>
    </form>
    <div id="projects-list">
      <div id="projects-empty-sidebar" class="empty-state">No projects yet</div>
    </div>
  </div>

  <div id="projects-main">
    <div id="projects-empty-main" class="empty-state" style="padding:60px 32px">
      Select a project from the sidebar
    </div>
    <div id="project-view" hidden>
      <div id="project-header"></div>
      <div id="task-pipeline"></div>
      <div id="task-detail" hidden>
        <div id="task-detail-header"></div>
        <div id="task-detail-meta"></div>
        <div id="task-detail-body"></div>
        <div id="task-detail-actions"></div>
      </div>
    </div>
  </div>
</div>
```

---

### CSS additions

```css
/* ── Projects tab ─────────────────────────────────────────────────────────── */
#tab-projects { display: flex; }  /* already set — override coming-soon style */

#projects-sidebar {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

#projects-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Add project form */
#add-project-form {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.form-field { display: flex; flex-direction: column; gap: 3px; }
.form-label { font-size: 10px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.08em; }
.form-input {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font-family: var(--font);
  font-size: 11px;
  padding: 5px 8px;
  outline: none;
}
.form-input:focus { border-color: var(--accent); }
.form-actions { display: flex; gap: 6px; }

/* Sidebar toggle button */
.sidebar-toggle-btn {
  width: 100%;
  background: none;
  border: none;
  color: var(--accent-bright);
  font-family: var(--font);
  font-size: 11px;
  padding: 10px 12px;
  cursor: pointer;
  text-align: left;
  letter-spacing: 0.04em;
}
.sidebar-toggle-btn:hover { background: var(--accent-faint); }

/* Project cards */
.project-card {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  background: var(--accent-faint);
}
.project-card:hover { background: var(--accent-subtle); border-color: rgba(204,82,0,0.45); }
.project-card.selected { background: rgba(204,82,0,0.12); border-color: var(--accent); }
.project-card-name { font-size: 12px; color: var(--text); margin-bottom: 3px; }
.project-card-meta { font-size: 10px; color: var(--text-muted); display: flex; gap: 8px; }

/* Project status badges */
.proj-status-active              { color: var(--success); }
.proj-status-kickoff_pending,
.proj-status-kickoff_in_progress,
.proj-status-onboarding_requested,
.proj-status-onboarding_in_progress { color: var(--accent-bright); }
.proj-status-declined            { color: var(--error); }
.proj-status-archived            { color: var(--text-faint); }

/* Projects main area */
#projects-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

#project-header {
  padding: 14px 20px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.project-title { font-size: 14px; font-weight: 700; color: var(--text-heading); }
.project-subtitle { font-size: 11px; color: var(--text-muted); margin-top: 3px; }

/* Task pipeline */
#task-pipeline {
  display: flex;
  gap: 12px;
  padding: 16px;
  overflow-x: auto;
  flex: 1;
  align-items: flex-start;
}
#task-pipeline::-webkit-scrollbar { height: 3px; }
#task-pipeline::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.pipeline-lane {
  width: 200px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pipeline-lane-header {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-faint);
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2px;
}
.pipeline-lane-count {
  background: rgba(204,82,0,0.2);
  color: var(--accent-bright);
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 9px;
  margin-left: 6px;
}

/* Task cards */
.task-card {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  cursor: pointer;
  background: var(--accent-faint);
  transition: background 0.15s, border-color 0.15s;
}
.task-card:hover { background: var(--accent-subtle); border-color: rgba(204,82,0,0.45); }
.task-card.selected { background: rgba(204,82,0,0.12); border-color: var(--accent); }
.task-card-title { font-size: 11px; color: var(--text); margin-bottom: 4px; line-height: 1.35; }
.task-card-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.task-status-badge {
  font-size: 8px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; padding: 1px 5px; border-radius: 3px;
  background: rgba(204,82,0,0.15); color: var(--accent-bright);
  border: 1px solid rgba(204,82,0,0.3);
}
.task-status-badge.status-done     { background: rgba(125,209,154,0.15); color: var(--success); border-color: rgba(125,209,154,0.3); }
.task-status-badge.status-cancelled{ background: rgba(255,255,255,0.05); color: var(--text-faint); border-color: rgba(255,255,255,0.12); }
.task-status-badge.status-blocked  { background: rgba(224,69,69,0.15); color: var(--error); border-color: rgba(224,69,69,0.3); }
.task-crafter-type { font-size: 9px; color: var(--text-faint); }

/* Task detail panel */
#task-detail {
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  height: 300px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
#task-detail-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.task-detail-title { font-size: 13px; color: var(--text-heading); flex: 1; }
.task-detail-close {
  background: none; border: none; color: var(--text-faint);
  font-family: var(--font); font-size: 14px; cursor: pointer; padding: 2px 6px;
}
.task-detail-close:hover { color: var(--text); }
#task-detail-meta {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  display: flex; gap: 20px; flex-wrap: wrap;
  flex-shrink: 0;
}
.task-meta-item { display: flex; flex-direction: column; gap: 2px; }
.task-meta-label { font-size: 9px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.08em; }
.task-meta-value { font-size: 11px; color: var(--text); }
#task-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  font-size: 11px;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
}
#task-detail-actions {
  display: flex;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
```

---

### app.js additions

**New state:**
```javascript
// Projects tab state
const projects = new Map();      // slug → ProjectRegistry
const projectTasks = new Map();  // taskId → TaskRecord (for selected project)
let selectedProjectSlug = null;
let selectedTaskId = null;
```

**New functions:**

`loadProjects()` — called when Projects tab is first activated:
```javascript
async function loadProjects() {
  const res = await fetch('/api/projects');
  const list = await res.json();
  projects.clear();
  for (const p of list) projects.set(p.slug, p);
  renderProjectList();
}
```

`renderProjectList()` — renders project cards in sidebar:
- Clears `#projects-list`, rebuilds from `projects` Map
- Each card: name, status (with CSS class `proj-status-{status}`), crafter_types joined, active task count
- Click → `selectProject(slug)`

`selectProject(slug)` — fetches tasks and renders:
```javascript
async function selectProject(slug) {
  selectedProjectSlug = slug;
  selectedTaskId = null;
  renderProjectList();  // update selected state on cards
  const res = await fetch(`/api/projects/${slug}/tasks`);
  const list = await res.json();
  projectTasks.clear();
  for (const t of list) projectTasks.set(t.frontmatter.id, t);
  renderProjectHeader();
  renderPipeline();
  $('projects-empty-main').hidden = true;
  $('project-view').style.display = 'flex';
}
```

`renderPipeline()` — builds Kanban lanes:
```javascript
const LANES = [
  { id: 'queued',      label: 'Queued',      statuses: ['pending','blocked'] },
  { id: 'research',    label: 'Research',    statuses: ['research_pending','research_review'] },
  { id: 'in_progress', label: 'In Progress', statuses: ['assigned','in_progress','crafter_revision'] },
  { id: 'review',      label: 'Review',      statuses: ['steward_review','steward_final','compound','council_review','council_peer_review','drift_detected','drift_cleared'] },
  { id: 'done',        label: 'Done',        statuses: ['done','cancelled'] },
];
```
- Builds one `.pipeline-lane` per entry, with `.pipeline-lane-header` (label + count badge)
- Each task matching the lane's statuses gets a `.task-card`
- Click task card → `selectTask(id)`

`selectTask(id)` — renders task detail panel:
- Gets task from `projectTasks`
- Renders `#task-detail-header`: title + close button
- Renders `#task-detail-meta`: status, priority, crafter_type, assigned_crafter, updated_at
- Renders `#task-detail-body`: `task.body.trim()`
- Renders `#task-detail-actions`: Block button (if not blocked/done/cancelled), Unblock (if blocked)
- Shows `#task-detail` pane

`renderTaskDetailActions(task)`:
- If status is `blocked`: show "Unblock" button → `POST /api/projects/:slug/tasks/:id/unblock`
- If status is not in `['done','cancelled','blocked']`: show "Block" button → `POST /api/projects/:slug/tasks/:id/block`

**Add-project form:**
```javascript
$('add-project-btn').addEventListener('click', () => {
  $('add-project-form').hidden = !$('add-project-form').hidden;
});
$('add-project-cancel').addEventListener('click', () => {
  $('add-project-form').hidden = true;
  $('add-project-form').reset();
});
$('add-project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('proj-name').value.trim();
  const path = $('proj-path').value.trim();
  const crafterTypes = $('proj-crafters').value.split(',').map(s => s.trim()).filter(Boolean);
  await apiPost('/api/projects', { name, path, crafterTypes });
  $('add-project-form').hidden = true;
  $('add-project-form').reset();
  await loadProjects();
});
```

**WebSocket handler addition:**
```javascript
} else if (msg.type === 'task_update') {
  // Update in projectTasks if it belongs to the selected project
  const t = msg.task;
  if (t.frontmatter.project === selectedProjectSlug) {
    projectTasks.set(t.frontmatter.id, t);
    renderPipeline();
    if (selectedTaskId === t.frontmatter.id) selectTask(t.frontmatter.id);
  }
}
```

**Tab activation hook** — in `switchTab`:
```javascript
if (name === 'projects' && projects.size === 0) loadProjects();
```

---

## Testing Checklist

- [ ] Projects sidebar lists all projects from registry.json
- [ ] Status badges use correct color per status
- [ ] Add New Project form submits and creates a project_assignment approval
- [ ] Selecting a project shows task pipeline with correct lane assignments
- [ ] Task count badges on lanes are accurate
- [ ] Clicking a task card opens the detail panel
- [ ] Task detail shows correct meta, body, and actions
- [ ] Block/unblock buttons write correct status to task file
- [ ] Real-time: changing a task file updates the pipeline automatically
- [ ] Selecting a different project clears the previous pipeline
- [ ] Task detail close button works
