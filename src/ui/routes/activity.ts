import { Router } from "express";
import type { ActivityWatcher } from "../activityWatcher.js";

export function createActivityRoutes(watcher: ActivityWatcher): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(watcher.getRecent());
  });

  return router;
}
