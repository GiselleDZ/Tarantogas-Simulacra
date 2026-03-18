/**
 * Project routes — REST API for the Projects tab.
 *
 * GET  /api/projects                            List all projects
 * POST /api/projects                            Onboard a new project
 * GET  /api/projects/:slug/tasks                Tasks for a project
 * GET  /api/projects/:slug/tasks/:taskId        Single task
 * POST /api/projects/:slug/tasks/:taskId/block  Set task to blocked
 * POST /api/projects/:slug/tasks/:taskId/unblock Set task to pending
 */
import { Router } from "express";
import { z } from "zod";
import path from "path";
import { promises as fs } from "fs";
import { FileLock } from "../../io/lock.js";
import { readMarkdownFile, writeMarkdownFile } from "../../io/fileStore.js";
import { listProjects, onboardProject } from "../../workflow/onboarding.js";
import type { TaskWatcher } from "../taskWatcher.js";
import type { TaskFrontmatter } from "../../types/index.js";

const OnboardSchema = z.object({
  name: z.string().min(1).max(80),
  path: z.string().min(1),
  crafterTypes: z.array(z.string().min(1)).min(1),
});

function isValidSlug(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9-]+$/.test(s);
}

function isValidTaskId(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && !s.includes("/") && !s.includes("..");
}

export function createProjectRoutes(taskWatcher: TaskWatcher): Router {
  const router = Router();

  // GET /api/projects
  router.get("/", (_req, res, next) => {
    listProjects()
      .then((projects) => {
        const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
        res.json(sorted);
      })
      .catch(next);
  });

  // POST /api/projects
  router.post("/", (req, res, next) => {
    const parsed = OnboardSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const { name, path: projectPath, crafterTypes } = parsed.data;
    onboardProject({ name, path: projectPath, crafterTypes, requestedBy: "tarantoga" })
      .then((result) => res.json(result))
      .catch(next);
  });

  // GET /api/projects/:slug/tasks
  router.get("/:slug/tasks", (req, res) => {
    const slug = req.params["slug"];
    if (!isValidSlug(slug)) { res.status(400).json({ error: "Invalid slug" }); return; }
    res.json(taskWatcher.getByProject(slug));
  });

  // GET /api/projects/:slug/tasks/:taskId
  router.get("/:slug/tasks/:taskId", (req, res) => {
    const { slug, taskId } = req.params as { slug: string; taskId: string };
    if (!isValidSlug(slug) || !isValidTaskId(taskId)) {
      res.status(400).json({ error: "Invalid params" });
      return;
    }
    const task = taskWatcher.get(taskId);
    if (task === undefined || task.frontmatter.project !== slug) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  });

  // POST /api/projects/:slug/tasks/:taskId/block
  router.post("/:slug/tasks/:taskId/block", (req, res, next) => {
    const { slug, taskId } = req.params as { slug: string; taskId: string };
    if (!isValidSlug(slug) || !isValidTaskId(taskId)) {
      res.status(400).json({ error: "Invalid params" });
      return;
    }
    const task = taskWatcher.get(taskId);
    if (task === undefined || task.frontmatter.project !== slug) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const lock = new FileLock(task.filePath);
    lock.withLock(async () => {
      const doc = await readMarkdownFile<TaskFrontmatter>(task.filePath);
      if (doc === null) throw new Error("Task file unreadable");
      await writeMarkdownFile(task.filePath, {
        ...doc.frontmatter,
        status: "blocked",
        assigned_crafter: null,
        updated_at: new Date().toISOString(),
      }, doc.body);
    })
      .then(() => res.json({ ok: true }))
      .catch(next);
  });

  // POST /api/projects/:slug/tasks/:taskId/unblock
  router.post("/:slug/tasks/:taskId/unblock", (req, res, next) => {
    const { slug, taskId } = req.params as { slug: string; taskId: string };
    if (!isValidSlug(slug) || !isValidTaskId(taskId)) {
      res.status(400).json({ error: "Invalid params" });
      return;
    }
    const task = taskWatcher.get(taskId);
    if (task === undefined || task.frontmatter.project !== slug) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const lock = new FileLock(task.filePath);
    lock.withLock(async () => {
      const doc = await readMarkdownFile<TaskFrontmatter>(task.filePath);
      if (doc === null) throw new Error("Task file unreadable");
      await writeMarkdownFile(task.filePath, {
        ...doc.frontmatter,
        status: "pending",
        updated_at: new Date().toISOString(),
      }, doc.body);
    })
      .then(() => res.json({ ok: true }))
      .catch(next);
  });

  return router;
}
