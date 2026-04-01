import { Router } from "express";
import type { SystemHealthWatcher } from "../systemHealthWatcher.js";

export function createSystemRoutes(watcher: SystemHealthWatcher): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(watcher.getSnapshot());
  });

  return router;
}
