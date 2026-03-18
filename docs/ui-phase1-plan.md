# Phase 1 Implementation Plan — Approval Queue Web UI

## Overview

Build a local web server that displays and manages the approval queue in a browser. Runs alongside the orchestrator as a separate process. No orchestrator code changes.

## New Files

```
src/ui/
  server.ts            ← Express app + WebSocket setup + startup
  approvalWatcher.ts   ← Watches state/approvals/, loads context, pushes to clients
  contextLoader.ts     ← Assembles context for an approval (research + task sections)
  routes/
    approvals.ts       ← REST endpoints: list, get context, decide

public/
  index.html           ← Single page layout (queue + detail panel)
  app.js               ← WebSocket client, rendering, action buttons
  style.css            ← Minimal styling
```

## Files Modified

```
package.json           ← Add deps (express, ws), add "ui" start script
```

## No files modified in: orchestrator, approvalConsole, workflow, types, agents

---

## Step 1 — Dependencies

Add to `package.json`:
- `express` — HTTP server
- `ws` — WebSocket server
- `@types/express`, `@types/ws` — TypeScript types

New script: `"ui": "node dist/ui/server.js"`

---

## Step 2 — `src/ui/approvalWatcher.ts`

Watches `state/approvals/**/*.md` using the existing `Watcher` class. On any add/change:
- Reads the file with `readMarkdownFile`
- Emits the approval (frontmatter + body) to all connected WebSocket clients
- Maintains an in-memory map of all known approvals for snapshot requests (new client connects → send current state)

Also watches `state/inbox/tarantoga/unread/` to pick up priority signals.

---

## Step 3 — `src/ui/contextLoader.ts`

Called when the frontend requests context for a specific approval. Assembles:

1. **Full body** — already in the approval file, no truncation
2. **Research approval** — if `research_request_ref` is set, load `state/approvals/{ref}.md` and return its body
3. **Related task research** — for each ID in `related_task_refs`, load `state/tasks/**/{id}.md` and extract the `## Research Output` section
4. Returns a structured object: `{ researchApprovalBody, taskResearchSections: [{ taskId, content }] }`

This is read-only. No file writes.

---

## Step 4 — `src/ui/routes/approvals.ts`

Three endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/approvals` | Return all known approvals (frontmatter + body) sorted by priority then created_at |
| `GET` | `/api/approvals/:id/context` | Return assembled context (research + task sections) |
| `POST` | `/api/approvals/:id/decide` | Write decision to frontmatter; body: `{ decision, rationale? }` |

The `POST /decide` endpoint:
- Validates decision is one of: `approved`, `declined`, `deferred`, `needs_research`
- Calls `updateApprovalStatus` (same function `ApprovalConsole` uses, uses `FileLock`)
- Fires the `onApprovalDecided` callback if the UI server was wired with one
- Returns `{ ok: true }` or `{ ok: false, error: string }`

---

## Step 5 — `src/ui/server.ts`

```
startUIServer(options: { port: number, onApprovalDecided?: ApprovalDecidedCallback })
  → starts Express on options.port
  → mounts routes
  → starts WebSocket server on same HTTP server
  → starts approvalWatcher, passes WebSocket broadcast function
  → logs: "Simulacra UI: http://localhost:{port}"
```

Exported as a function so `orchestrator.ts` can optionally start it (or it can run standalone).

Standalone mode: `if (import.meta.url === pathToFileURL(process.argv[1]).href)` → call `startUIServer({ port: 4242 })`.

---

## Step 6 — `public/index.html` + `public/app.js`

### Layout
```
┌─────────────────────────────────────────────────────────┐
│  SIMULACRA APPROVALS          [3 pending] [2 decided]   │
├───────────────────┬─────────────────────────────────────┤
│  QUEUE            │  DETAIL                             │
│                   │                                     │
│  ● plan_approval  │  [Type]  [Project]  [From]          │
│    project-alpha  │  [Council rec: approve]             │
│    council-xyz    │                                     │
│    ── urgent ──   │  ─ Body ─────────────────────────   │
│                   │  [full markdown body]               │
│  ● new_mcp        │                                     │
│    project-beta   │  ▸ Show research context            │
│                   │    (expands inline)                 │
│  ✓ task_cancel    │                                     │
│    auto-approved  │  [Approve] [Decline] [Defer]        │
│                   │  [Mark pending]                     │
└───────────────────┴─────────────────────────────────────┘
```

### WebSocket behavior
- On connect: server sends `{ type: "snapshot", approvals: [...] }`
- On file change: server sends `{ type: "approval_update", approval: {...} }`
- Frontend reconciles its list — no full reload

### Context toggle
Clicking "Show research context" on an approval:
1. Calls `GET /api/approvals/:id/context`
2. Renders in a collapsible panel below the body:
   - **Research findings** — full body of the linked research approval (if any)
   - Per related task: task ID header + the `## Research Output` content

### Decision flow
1. Click Approve/Decline/Defer button
2. Optional: browser `prompt()` for rationale (or inline text input)
3. `POST /api/approvals/:id/decide`
4. On success: approval card updates status badge in real-time via WebSocket

---

## Step 7 — Wire into orchestrator (optional for Phase 1)

In `src/orchestrator.ts`, after starting `ApprovalConsole`:

```typescript
if (config.ui?.enabled) {
  await startUIServer({
    port: config.ui.port ?? 4242,
    onApprovalDecided: handleApprovalDecided,
  });
}
```

Add to `config/simulacra.yaml`:
```yaml
ui:
  enabled: true
  port: 4242
```

The `ApprovalConsole` continues to run but in non-interactive mode (stdin check fails → leaves approvals pending → UI handles them). No code changes to `ApprovalConsole` needed.

---

## Implementation Order

1. `package.json` — add deps
2. `src/ui/approvalWatcher.ts` — core watcher, no dependencies on other new files
3. `src/ui/contextLoader.ts` — pure read logic
4. `src/ui/routes/approvals.ts` — REST layer
5. `src/ui/server.ts` — wires everything together
6. `public/` — HTML + JS (can test against running server)
7. `config/simulacra.yaml` — add `ui:` block
8. `src/orchestrator.ts` — add optional UI start

## Testing Approach

1. Start UI server standalone: `npm run ui`
2. Manually create a test approval file in `state/approvals/`
3. Verify it appears in browser queue
4. Click "Show research context" with a linked research approval — verify it loads
5. Make a decision — verify frontmatter updates and badge changes in real-time
6. Start orchestrator alongside — verify `onApprovalDecided` fires correctly for `plan_approval`

---

## Estimated Scope

| File | Lines (approx) |
|---|---|
| `approvalWatcher.ts` | ~80 |
| `contextLoader.ts` | ~70 |
| `routes/approvals.ts` | ~90 |
| `server.ts` | ~60 |
| `public/index.html` | ~60 |
| `public/app.js` | ~200 |
| `public/style.css` | ~100 |
| Config + orchestrator wiring | ~15 |
| **Total** | **~675** |
