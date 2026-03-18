/**
 * Approval routes — REST API for the UI dashboard.
 *
 * GET  /api/approvals            List all approvals (pending first)
 * GET  /api/approvals/:id/context  Load linked research + task sections
 * POST /api/approvals/:id/snooze   Mark as in_conversation
 * POST /api/approvals/:id/decide   Record a final decision
 */
import { Router } from "express";
import { z } from "zod";
import path from "path";
import { FileLock } from "../../io/lock.js";
import { updateApprovalStatus } from "../../workflow/approvalQueue.js";
import { loadContext } from "../contextLoader.js";
import type { ApprovalWatcher } from "../approvalWatcher.js";
import type { ApprovalDecidedCallback } from "../../io/approvalConsole.js";
import type { ApprovalDecision } from "../../types/index.js";

const DecideSchema = z.object({
  decision: z.enum(["approved", "declined", "deferred", "needs_research"]),
  rationale: z.string().optional(),
});

function isValidId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith("approval-");
}

export function createApprovalRoutes(
  watcher: ApprovalWatcher,
  onApprovalDecided?: ApprovalDecidedCallback,
): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const sorted = watcher.getAll().sort((a, b) => {
      const aScore = a.frontmatter.status === "pending" ? 0 : 1;
      const bScore = b.frontmatter.status === "pending" ? 0 : 1;
      if (aScore !== bScore) return aScore - bScore;
      return a.frontmatter.created_at.localeCompare(b.frontmatter.created_at);
    });
    res.json(sorted);
  });

  router.get("/:id/context", (req, res, next) => {
    const id = req.params["id"];
    if (!isValidId(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
    loadContext(id).then((ctx) => res.json(ctx)).catch(next);
  });

  router.post("/:id/snooze", (req, res, next) => {
    const id = req.params["id"];
    if (!isValidId(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
    const lock = new FileLock(path.join("state/approvals", `${id}.md`));
    lock.withLock(() => updateApprovalStatus(id, { status: "in_conversation" }))
      .then(() => res.json({ ok: true }))
      .catch(next);
  });

  router.post("/:id/decide", (req, res, next) => {
    const id = req.params["id"];
    if (!isValidId(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

    const parsed = DecideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }

    const { decision, rationale } = parsed.data;
    const lock = new FileLock(path.join("state/approvals", `${id}.md`));

    lock.withLock(() =>
      updateApprovalStatus(id, {
        status: "decided",
        decision: decision as ApprovalDecision,
        decision_rationale: rationale ?? `Set by Tarantoga via UI at ${new Date().toISOString()}.`,
      }),
    )
      .then(async () => {
        if (onApprovalDecided !== undefined) {
          const record = watcher.get(id);
          if (record !== undefined) {
            await onApprovalDecided(
              id,
              record.frontmatter.type,
              decision as ApprovalDecision,
              record.frontmatter.project,
              record.frontmatter.related_task_refs,
            );
          }
        }
        res.json({ ok: true });
      })
      .catch(next);
  });

  return router;
}
