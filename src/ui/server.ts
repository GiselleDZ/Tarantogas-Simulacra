/**
 * UI Server — Express + WebSocket server for the Simulacra dashboard.
 *
 * Start standalone: `tsx src/ui/server.ts`
 * Or wire into orchestrator via startUIServer().
 */
import http from "http";
import path from "path";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { ApprovalWatcher } from "./approvalWatcher.js";
import { ActivityWatcher } from "./activityWatcher.js";
import { TaskWatcher } from "./taskWatcher.js";
import { createApprovalRoutes } from "./routes/approvals.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createProjectRoutes } from "./routes/projects.js";
import type { ApprovalRecord } from "./approvalWatcher.js";
import type { ActivityEvent } from "./activityWatcher.js";
import type { TaskRecord } from "./taskWatcher.js";
import type { ApprovalDecidedCallback } from "../io/approvalConsole.js";

export interface UIServerOptions {
  readonly port: number;
  readonly onApprovalDecided?: ApprovalDecidedCallback;
}

type WsMessage =
  | { type: "snapshot";           approvals: ApprovalRecord[] }
  | { type: "approval_update";    approval: ApprovalRecord }
  | { type: "activity_snapshot";  events: ActivityEvent[] }
  | { type: "activity_lines";     events: ActivityEvent[] }
  | { type: "task_update";        task: TaskRecord };

function broadcast(clients: Set<WebSocket>, msg: WsMessage): void {
  const payload = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

export async function startUIServer(options: UIServerOptions): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.resolve(process.cwd(), "public")));

  const clients = new Set<WebSocket>();

  const watcher = new ApprovalWatcher((record) => {
    broadcast(clients, { type: "approval_update", approval: record });
  });

  const activityWatcher = new ActivityWatcher((events) => {
    broadcast(clients, { type: "activity_lines", events });
  });

  const taskWatcher = new TaskWatcher((task) => {
    broadcast(clients, { type: "task_update", task });
  });

  // Request logging for API calls
  app.use((req, _res, next) => {
    if (req.path.startsWith("/api")) console.log(`[UI] ${req.method} ${req.path}`);
    next();
  });

  app.use("/api/approvals", createApprovalRoutes(watcher, options.onApprovalDecided));
  app.use("/api/activity", createActivityRoutes(activityWatcher));
  app.use("/api/projects", createProjectRoutes(taskWatcher));

  // 404 handler — must come after all routes, returns JSON so the browser can parse it
  app.use((req, res) => {
    res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
  });

  // Error handler — returns the real message (local tool, no security concern)
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack   = err instanceof Error ? (err.stack ?? "") : "";
    console.error("[UI] Unhandled error:", err);
    res.status(500).json({ error: message, stack });
  };
  app.use(errorHandler);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "snapshot",          approvals: watcher.getAll() } satisfies WsMessage));
    ws.send(JSON.stringify({ type: "activity_snapshot", events:    activityWatcher.getRecent() } satisfies WsMessage));
    ws.on("close", () => { clients.delete(ws); });
    ws.on("error", () => { clients.delete(ws); });
  });

  await new Promise<void>((resolve) => { server.listen(options.port, resolve); });
  console.log(`[UI] Simulacra dashboard: http://localhost:${options.port}`);
}

// ── Standalone entry ───────────────────────────────────────────────────────────
// Run directly: tsx src/ui/server.ts
const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const port = Number(process.env["UI_PORT"] ?? 4242);
  startUIServer({ port }).catch((err: unknown) => {
    console.error("[UI] Fatal:", err);
    process.exit(1);
  });
}
