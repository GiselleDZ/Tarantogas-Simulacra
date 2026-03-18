# Phase 2 Implementation Plan — Tab Navigation + Activity Feed

## Overview

Two concerns in one plan:

1. **Tab navigation** — restructures the frontend so Phases 2–4 each have their own view. No new backend code.
2. **Activity Feed** — streams live `PHASE:` and `DECISION:` log lines from all task files to a dedicated tab. Two new backend files, no orchestrator changes.

---

## Part 1 — Tab Navigation

### What changes

| File | Change |
|---|---|
| `public/index.html` | Add `<nav class="tabs">` to header; wrap existing content in `#tab-approvals`; add placeholder panes for activity, projects, system |
| `public/style.css` | Tab button styles; tab pane layout rules; each pane owns its own internal layout |
| `public/app.js` | `switchTab()` function; click handlers on tab buttons; move pending count update to tab badge |

### No backend changes needed for tab nav

---

### HTML structure (before → after)

**Before:**
```html
<header>
  <div class="logo">SIMULACRA</div>
  <div class="header-title">Approval Queue</div>
  <div class="pending-badge" id="pending-count">— pending</div>
  <div class="ws-status" id="ws-status"></div>
</header>
<main>
  <aside id="queue">...</aside>
  <section id="detail">...</section>
</main>
```

**After:**
```html
<header>
  <div class="logo">SIMULACRA</div>
  <nav class="tabs">
    <button class="tab active" data-tab="approvals">
      Approvals <span class="tab-count" id="tab-count-approvals"></span>
    </button>
    <button class="tab" data-tab="activity">Activity</button>
    <button class="tab" data-tab="projects">Projects</button>
    <button class="tab" data-tab="system">System</button>
  </nav>
  <div class="ws-status" id="ws-status"></div>
</header>
<main>
  <div id="tab-approvals" class="tab-pane">
    <!-- existing aside + section, unchanged -->
    <aside id="queue">...</aside>
    <section id="detail">...</section>
  </div>
  <div id="tab-activity" class="tab-pane" hidden>
    <div id="activity-toolbar">
      <div class="role-filters">
        <button class="role-filter active" data-role="all">All</button>
        <button class="role-filter" data-role="council">Council</button>
        <button class="role-filter" data-role="steward">Steward</button>
        <button class="role-filter" data-role="crafter">Crafter</button>
        <button class="role-filter" data-role="research">Research</button>
      </div>
      <label class="autoscroll-label">
        <input type="checkbox" id="autoscroll" checked> Auto-scroll
      </label>
    </div>
    <div id="activity-feed"></div>
  </div>
  <div id="tab-projects" class="tab-pane" hidden>
    <div class="coming-soon">Projects — Phase 3</div>
  </div>
  <div id="tab-system" class="tab-pane" hidden>
    <div class="coming-soon">System Health — Phase 4</div>
  </div>
</main>
```

### CSS rules for tabs

```css
/* Tab nav in header */
.tabs { display: flex; gap: 2px; }

.tab {
  background: none;
  border: none;
  color: var(--text-muted);
  font-family: var(--font);
  font-size: 11px;
  padding: 5px 14px;
  cursor: pointer;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 6px;
}
.tab:hover { background: var(--accent-faint); color: var(--text); }
.tab.active { background: var(--accent-subtle); color: var(--accent-bright); }

.tab-count {
  background: rgba(204,82,0,0.25);
  color: var(--accent-bright);
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 9px;
  min-width: 16px;
  text-align: center;
}
.tab-count:empty { display: none; }

/* Tab pane layout */
/* main becomes a plain 100% container */
main { height: calc(100vh - 48px); }

.tab-pane { display: none; height: 100%; width: 100%; }

/* Approvals pane keeps the 2-column grid */
#tab-approvals { display: grid; grid-template-columns: 300px 1fr; }

/* Activity pane is a column */
#tab-activity { display: flex; flex-direction: column; overflow: hidden; }

/* Projects and System are simple scroll regions */
#tab-projects, #tab-system { display: flex; overflow-y: auto; }
```

> **Note:** The `hidden` attribute on inactive tab panes sets `display:none`. When removed, the pane gets its own display type from the rule above. No JS layout switching needed.

### app.js tab logic

```javascript
let activeTab = 'approvals';

function switchTab(name) {
  document.querySelector('.tab.active').classList.remove('active');
  document.getElementById(`tab-${activeTab}`).hidden = true;
  activeTab = name;
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  document.getElementById(`tab-${name}`).hidden = false;
}

for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}
```

The pending count moves from `#pending-count` span (removed) to `#tab-count-approvals` inside the Approvals tab button. The `renderQueue()` function updates it there instead.

---

## Part 2 — Activity Feed

### How it works

The UI server watches `state/tasks/**/*.md` using the same `Watcher` class used by `ApprovalWatcher`. On each file change it:
1. Reads the task file
2. Compares body length to the last known offset
3. Calls `parseAgentLogLines()` on the new content (already exists in `src/io/agentLog.ts`)
4. Determines role and agentId from task frontmatter (same logic as orchestrator's `statusToLogRole`)
5. Emits structured `ActivityEvent` objects via WebSocket

A ring buffer of the last 500 events is kept in memory so new browser connections receive recent history.

**No orchestrator changes needed.** The UI server reads the same files independently.

---

### New files

#### `src/ui/activityWatcher.ts`

Responsibilities:
- Watch `state/tasks/**/*.md`
- Track body offset per file (same pattern as orchestrator's `emittedBodyOffsets`)
- Parse new `PHASE:`/`DECISION:` lines on each change
- Maintain ring buffer of last 500 `ActivityEvent` objects
- Call `onEvents` callback with new batches (for WebSocket broadcast)

Key types:
```typescript
export type AgentLogRole = "council" | "steward" | "crafter" | "research";

export interface ActivityEvent {
  readonly id: string;         // "evt-{counter}" — monotonically increasing
  readonly taskId: string;     // frontmatter.id
  readonly project: string;    // frontmatter.project
  readonly role: AgentLogRole;
  readonly agentId: string;    // assigned_crafter / assigned_steward / etc.
  readonly type: "PHASE" | "DECISION";
  readonly message: string;
  readonly timestamp: string;  // ISO, set at time of detection
}
```

Role/agentId mapping (mirrors orchestrator logic exactly):
```
research_pending               → role: research,  agent: n/a (no assigned yet)
in_progress / crafter_revision → role: crafter,   agent: assigned_crafter
steward_review / steward_final → role: steward,   agent: assigned_steward
council_peer_review            → role: council,   agent: assigned_council_peer
everything else                → role: council,   agent: assigned_council_author
```

Public API:
```typescript
class ActivityWatcher {
  constructor(onEvents: (events: ActivityEvent[]) => void)
  getRecent(): ActivityEvent[]   // returns ring buffer copy
  close(): Promise<void>
}
```

---

#### `src/ui/routes/activity.ts`

Single endpoint:
```
GET /api/activity   →   returns ActivityEvent[]  (ring buffer snapshot)
```

Used when the browser first opens the Activity tab (loads recent history before WebSocket catches up).

---

### Modified files

#### `src/ui/server.ts`

Three additions:
1. Import and start `ActivityWatcher`
2. Mount `/api/activity` routes
3. Add `activity_lines` and `activity_snapshot` to `WsMessage` union type + broadcast on new events

Updated `WsMessage` union:
```typescript
type WsMessage =
  | { type: "snapshot";           approvals: ApprovalRecord[] }
  | { type: "approval_update";    approval: ApprovalRecord }
  | { type: "activity_snapshot";  events: ActivityEvent[] }
  | { type: "activity_lines";     events: ActivityEvent[] };
```

On new WebSocket connection, send both snapshots:
```typescript
ws.send(JSON.stringify({ type: "snapshot",          approvals: approvalWatcher.getAll() }));
ws.send(JSON.stringify({ type: "activity_snapshot", events:   activityWatcher.getRecent() }));
```

---

#### `public/index.html`

Changes described in Part 1 above. The approvals content moves inside `#tab-approvals` with no structural changes to the aside/section elements themselves.

---

#### `public/app.js`

New state:
```javascript
const activityEvents = [];   // client-side ring buffer (max 500)
let activeRoleFilter = 'all';
let autoscroll = true;
```

New functions:
- `appendActivityEvents(events)` — push to ring buffer, call `renderNewRows(events)` or full re-render depending on active filter
- `renderNewRows(events)` — append only new DOM rows (efficient path when no filter active)
- `renderActivityFeed()` — full re-render (used on filter change)
- `createEventRow(evt)` — builds one `<div class="activity-row">` element using `textContent` (no innerHTML for user data)

Role filter logic:
- Clicking a role filter button updates `activeRoleFilter` and triggers full re-render of the feed
- Does not fetch from server — just re-filters the client-side `activityEvents` array

Auto-scroll:
- When checkbox is checked and new rows arrive, `feed.scrollTop = feed.scrollHeight`
- When user manually scrolls up, auto-scroll automatically unchecks (via scroll event listener)

WebSocket handler additions:
```javascript
if (msg.type === 'activity_snapshot') {
  activityEvents.length = 0;
  activityEvents.push(...msg.events);
  renderActivityFeed();
}
if (msg.type === 'activity_lines') {
  activityEvents.push(...msg.events);
  if (activityEvents.length > 500) activityEvents.splice(0, activityEvents.length - 500);
  if (activeTab === 'activity') appendActivityEvents(msg.events);
}
```

---

#### `public/style.css`

Additions:

**Role colors** — semantic, separate from amber theme:
```css
.role-council  { --role-color: #C084FC; }  /* purple */
.role-steward  { --role-color: #FCD34D; }  /* yellow */
.role-crafter  { --role-color: #60A5FA; }  /* blue */
.role-research { --role-color: #34D399; }  /* cyan */
```

**Activity toolbar:**
```css
#activity-toolbar {
  display: flex; align-items: center; gap: 16px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
```

**Role filter buttons** — similar to the existing `.btn` pattern but smaller, with active state tinted by role color:
```css
.role-filter { ... }
.role-filter.active[data-role="council"] { color: #C084FC; border-color: rgba(192,132,252,0.4); }
.role-filter.active[data-role="steward"] { color: #FCD34D; border-color: rgba(252,211,77,0.4); }
.role-filter.active[data-role="crafter"] { color: #60A5FA; border-color: rgba(96,165,250,0.4); }
.role-filter.active[data-role="research"]{ color: #34D399; border-color: rgba(52,211,153,0.4); }
```

**Activity feed rows** — monospace, dense, terminal-like:
```
[10:42:31]  COUNCIL  council-abc  [task-xyz]  PHASE  │  Starting council review...
```

Each column is a fixed-width span. The message column fills remaining space. Role name is colored by `--role-color`.

---

## Implementation Order

1. `src/ui/activityWatcher.ts` — no deps on other new files
2. `src/ui/routes/activity.ts` — depends on activityWatcher
3. `src/ui/server.ts` — wire in activityWatcher + routes + new WS messages
4. `public/style.css` — add tab styles + activity styles
5. `public/index.html` — restructure with tab panes
6. `public/app.js` — tab switching + activity feed logic

Order 5 and 6 can be done together since they're purely frontend.

---

## Testing Checklist

- [ ] Clicking each tab button shows the correct pane
- [ ] Approvals tab works exactly as before (no regression)
- [ ] Projects and System tabs show "coming soon" placeholder
- [ ] Pending count appears as a badge inside the Approvals tab button
- [ ] Activity tab loads recent events from `/api/activity` on first open
- [ ] New `PHASE:`/`DECISION:` lines in task files appear in the feed in real-time
- [ ] Role filter buttons correctly filter the visible rows
- [ ] Auto-scroll works; manual scroll up pauses it
- [ ] New browser tab connection receives both approval snapshot and activity snapshot
- [ ] Reconnect after WebSocket drop re-receives both snapshots cleanly
