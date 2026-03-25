/**
 * Task scheduler — assigns pending tasks to available agents.
 *
 * The scheduler is called by the orchestrator on a regular interval.
 * It scans for pending tasks and spawns agents to work on them,
 * respecting task dependencies and priority ordering.
 */
import path from "path";
import { promises as fs } from "fs";
import { readMarkdownFile, writeMarkdownFile, writeFile } from "./io/fileStore.js";
import { readRegistry } from "./agents/spawner.js";
import { spawnCrafter } from "./agents/crafter.js";
import { spawnCouncilForKickoff } from "./agents/council.js";
import { evaluateTransitions, scrubSentinels } from "./workflow/taskPipeline.js";
import { listProjects, setProjectStatus } from "./workflow/onboarding.js";
import { createApproval } from "./workflow/approvalQueue.js";
import { randomUUID } from "crypto";
import type {
  TaskFrontmatter,
  TaskStatus,
  AgentRole,
  LiveAgentRegistry,
} from "./types/index.js";

export function sanitizePathSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const TASKS_DIR = "state/tasks";

export const MAX_CONCURRENT_AGENTS = 8;

const MAX_KICKOFF_ATTEMPTS = 3;
const kickoffFailures = new Map<string, number>();
const notifiedOrphans = new Set<string>();
const notifiedCycles = new Set<string>();
const notifiedStaleAgents = new Set<string>();
const notifiedOverBudget = new Set<string>(); // project slugs over per-project budget
let notifiedGlobalBudget = false;

/**
 * How long after assignment before we consider a crafter "orphaned".
 * This prevents the scheduler from treating a newly-assigned task as orphaned
 * before the agent process has had time to call registerAgent() on the live registry.
 */
const CRAFTER_REGISTRATION_GRACE_MS = 30_000;
const REVIEW_REGISTRATION_GRACE_MS = 30_000;

interface SchedulerDependencies {
  readonly rolesConfig: Parameters<typeof spawnCrafter>[5]["rolesConfig"];
  readonly simulacraConfig: Parameters<typeof spawnCrafter>[5]["simulacraConfig"];
  readonly onAgentResult: Parameters<typeof spawnCrafter>[6];
  readonly onOrphanedReviewTask?: (filePath: string, status: TaskStatus) => Promise<void>;
  /** Max concurrent agents per project slug. Default: no per-project cap. */
  readonly maxAgentsPerProject?: number;
  /** Milliseconds of log silence before an agent is flagged as potentially stuck. */
  readonly heartbeatTimeoutMs?: number;
  /** Cost budget limits. Spawning is blocked when a limit is reached. */
  readonly budget?: {
    readonly per_project_usd?: number;
    readonly global_usd?: number;
  };
}

interface PendingTask {
  readonly filePath: string;
  readonly frontmatter: TaskFrontmatter;
}

/**
 * Scan all project task directories for tasks that are ready to be assigned.
 * Returns tasks sorted by priority (critical → high → medium → low).
 */
async function scanPendingTasks(): Promise<PendingTask[]> {
  const tasks: PendingTask[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(TASKS_DIR);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const projectTasksPath = path.join(TASKS_DIR, projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(projectTasksPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(projectTasksPath, entry);
      const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
      if (doc === null) continue;

      const { frontmatter } = doc;
      if (
        frontmatter.status === "pending" ||
        frontmatter.status === "assigned"
      ) {
        tasks.push({ filePath, frontmatter });
      }
    }
  }

  return tasks.sort(comparePriority);
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function comparePriority(a: PendingTask, b: PendingTask): number {
  const pa = PRIORITY_ORDER[a.frontmatter.priority] ?? 2;
  const pb = PRIORITY_ORDER[b.frontmatter.priority] ?? 2;
  return pa - pb;
}

/**
 * Check whether all tasks listed in blocked_by are done.
 */
async function dependenciesResolved(
  task: PendingTask,
): Promise<boolean> {
  for (const depId of task.frontmatter.blocked_by) {
    // Simple scan: look for the task file containing this ID in frontmatter
    // A more efficient implementation would maintain an index
    const depResolved = await isDoneById(depId);
    if (!depResolved) return false;
  }
  return true;
}

async function isDoneById(taskId: string): Promise<boolean> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(TASKS_DIR);
  } catch {
    return false;
  }

  for (const projectDir of projectDirs) {
    const projectTasksPath = path.join(TASKS_DIR, projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(projectTasksPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const doc = await readMarkdownFile<TaskFrontmatter>(
        path.join(projectTasksPath, entry),
      );
      if (doc?.frontmatter.id === taskId) {
        return doc.frontmatter.status === "done";
      }
    }
  }

  return false;
}

/**
 * Reset an orphaned task (assigned but no live agent) back to pending.
 */
async function resetOrphanedTask(filePath: string): Promise<void> {
  const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
  if (doc === null) return;
  const updated: TaskFrontmatter = {
    ...doc.frontmatter,
    status: "pending",
    assigned_crafter: null,
    updated_at: new Date().toISOString(),
  };
  // Scrub any stale sentinels so the new crafter assignment doesn't
  // immediately re-trigger a transition from a prior work block.
  await writeMarkdownFile(filePath, updated, scrubSentinels(doc.body));
  console.warn(`[Scheduler] Orphaned task reset to pending: ${filePath}`);
}

async function notifyKickoffFailed(slug: string, failures: number): Promise<void> {
  await createApproval({
    type: "task_cancellation",
    createdBy: "orchestrator",
    project: slug,
    councilRecommendation: "needs_research",
    relatedTaskRefs: [],
    body: [
      "## Kickoff Failed",
      "",
      `Project \`${slug}\` failed to kickoff after ${failures} consecutive attempts.`,
      "",
      "The project has been set to `kickoff_failed` status.",
      "Manual intervention required — check agent logs for details.",
    ].join("\n"),
    urgent: true,
  });
}

function getReviewTaskAssignedAgent(fm: TaskFrontmatter): string | null {
  if (fm.status === "steward_review" || fm.status === "steward_final") return fm.assigned_steward;
  if (fm.status === "council_peer_review") return fm.assigned_council_peer;
  if (fm.status === "research_pending" || fm.status === "research_review") return null;
  return fm.assigned_council_author;
}

const REVIEW_STATUSES: TaskStatus[] = [
  "steward_review", "steward_final",
  "council_review", "council_peer_review",
  "research_pending", "research_review",
];

/**
 * Scan tasks in mid-review states. For spawnable review states, calls the
 * onOrphanedReviewTask callback (if provided) to respawn the agent. For research
 * states where no conventional agent field exists, writes an inbox notification.
 */
async function scanOrphanedReviewTasks(registry: LiveAgentRegistry, deps: SchedulerDependencies): Promise<void> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(TASKS_DIR);
  } catch {
    return;
  }

  for (const projectDir of projectDirs) {
    const projectTasksPath = path.join(TASKS_DIR, projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(projectTasksPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(projectTasksPath, entry);
      const doc = await readMarkdownFile<TaskFrontmatter>(filePath);
      if (doc === null) continue;

      const { frontmatter } = doc;
      if (!REVIEW_STATUSES.includes(frontmatter.status)) continue;

      const agentId = getReviewTaskAssignedAgent(frontmatter);
      if (agentId === null) continue;
      if (registry[agentId] !== undefined) continue;

      const isSpawnable =
        frontmatter.status !== "research_pending" &&
        frontmatter.status !== "research_review";

      if (isSpawnable && deps.onOrphanedReviewTask !== undefined) {
        // Use task ID only as the key — handleTransition writes a new agent UUID to
        // assigned_steward/assigned_council_* each time it runs, so a key containing
        // the agent ID would be bypassed on the very next scheduler cycle.
        const notifyKey = frontmatter.id;
        if (notifiedOrphans.has(notifyKey)) continue;
        // Grace period: the task may have just been updated by startup recovery or a
        // prior respawn attempt. Skip until the new agent has had time to register.
        const assignedAgeMs = Date.now() - new Date(frontmatter.updated_at).getTime();
        if (assignedAgeMs < REVIEW_REGISTRATION_GRACE_MS) continue;
        notifiedOrphans.add(notifyKey);
        console.warn(`[Scheduler] Orphaned review task — respawning: ${frontmatter.id} (status=${frontmatter.status}, missing agent=${agentId})`);
        await deps.onOrphanedReviewTask(filePath, frontmatter.status);
      } else {
        // Notification-only path (research statuses or no callback provided).
        // Agent ID is stable here — no handleTransition runs to change it.
        const notifyKey = `${frontmatter.id}:${agentId}`;
        if (notifiedOrphans.has(notifyKey)) continue;
        notifiedOrphans.add(notifyKey);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const notifPath = `state/inbox/tarantoga/unread/orphan-${sanitizePathSegment(frontmatter.id)}-${timestamp}.md`;
        await writeFile(
          notifPath,
          [
            `## Orphaned Review Task: ${frontmatter.id}`,
            "",
            `Task \`${frontmatter.id}\` is in status \`${frontmatter.status}\` but its assigned agent \`${agentId}\` is no longer in the live registry.`,
            "",
            `**Task file:** \`${filePath}\``,
            "",
            "The task has NOT been automatically reset — manual review required.",
            "Decide whether to reset to pending, assign a new reviewer, or cancel.",
            "",
            `**Detected at:** ${new Date().toISOString()}`,
          ].join("\n"),
        );
        console.warn(`[Scheduler] Orphaned review task detected: ${frontmatter.id} (status=${frontmatter.status}, missing agent=${agentId})`);
      }
    }
  }
}

// ── Dependency graph helpers ──────────────────────────────────────────────────

/** Load a map of taskId → blocked_by for all tasks across all projects. */
async function buildDependencyGraph(): Promise<Map<string, readonly string[]>> {
  const graph = new Map<string, readonly string[]>();
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(TASKS_DIR);
  } catch {
    return graph;
  }
  for (const projectDir of projectDirs) {
    const projectTasksPath = path.join(TASKS_DIR, projectDir);
    let entries: string[];
    try {
      entries = await fs.readdir(projectTasksPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const doc = await readMarkdownFile<TaskFrontmatter>(path.join(projectTasksPath, entry));
      if (doc === null) continue;
      graph.set(doc.frontmatter.id, doc.frontmatter.blocked_by);
    }
  }
  return graph;
}

/**
 * Detect whether `startId` participates in a dependency cycle.
 * Uses iterative DFS with an explicit stack — stack overflow safe.
 */
export function hasCycle(startId: string, graph: Map<string, readonly string[]>): boolean {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: Array<{ id: string; idx: number }> = [{ id: startId, idx: 0 }];
  inStack.add(startId);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const deps = graph.get(frame.id) ?? [];

    if (frame.idx >= deps.length) {
      inStack.delete(frame.id);
      visited.add(frame.id);
      stack.pop();
      continue;
    }

    const dep = deps[frame.idx]!;
    frame.idx++;

    if (inStack.has(dep)) return true; // back edge → cycle
    if (visited.has(dep)) continue;

    inStack.add(dep);
    stack.push({ id: dep, idx: 0 });
  }
  return false;
}

// ── Stuck agent detection ─────────────────────────────────────────────────────

/**
 * Check each live agent's log file modification time.
 * If an agent has been silent for longer than heartbeatTimeoutMs, log a warning.
 */
async function checkStaleAgents(
  registry: LiveAgentRegistry,
  heartbeatTimeoutMs: number,
): Promise<void> {
  const now = Date.now();
  for (const [agentId, _identity] of Object.entries(registry)) {
    const logPath = path.resolve(`logs/${agentId}.log`);
    let silenceMs: number;
    try {
      const stats = await fs.stat(logPath);
      silenceMs = now - stats.mtimeMs;
    } catch {
      continue; // no log file yet — agent may not have written anything
    }

    if (silenceMs > heartbeatTimeoutMs) {
      if (!notifiedStaleAgents.has(agentId)) {
        notifiedStaleAgents.add(agentId);
        const mins = Math.round(silenceMs / 60_000);
        console.warn(
          `[Scheduler] Agent ${agentId} has been silent for ${mins} min — may be stuck. Check logs/${agentId}.log`,
        );
      }
    } else {
      // Agent active again — clear the notification so it can be re-triggered later
      notifiedStaleAgents.delete(agentId);
    }
  }
}

// ── Budget helpers ────────────────────────────────────────────────────────────

/** Cache per-project cost totals for 30 s to avoid re-reading on every cycle. */
const projectCostCache = new Map<string, { total: number; ts: number }>();
const COST_CACHE_TTL_MS = 30_000;

async function getProjectCostTotal(slug: string): Promise<number> {
  const cached = projectCostCache.get(slug);
  if (cached !== undefined && Date.now() - cached.ts < COST_CACHE_TTL_MS) {
    return cached.total;
  }
  let total = 0;
  try {
    const raw = await fs.readFile(`state/projects/${slug}/costs.jsonl`, "utf-8");
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const cost = entry.cost_usd;
        if (typeof cost === "number" && isFinite(cost) && cost >= 0) {
          total += cost;
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* no costs file yet */ }
  projectCostCache.set(slug, { total, ts: Date.now() });
  return total;
}

async function getGlobalCostTotal(): Promise<number> {
  let total = 0;
  let slugs: string[];
  try {
    slugs = await fs.readdir("state/projects");
  } catch {
    return 0;
  }
  for (const entry of slugs) {
    try {
      const stat = await fs.stat(path.join("state/projects", entry));
      if (!stat.isDirectory()) continue;
    } catch { continue; }
    total += await getProjectCostTotal(entry);
  }
  return total;
}

/**
 * Run one scheduling cycle: assign pending tasks to new agents.
 * Called by the orchestrator on its poll interval.
 */
export async function runSchedulerCycle(
  deps: SchedulerDependencies,
): Promise<void> {
  // Detect and launch kickoff agents for newly activated projects
  const kickoffProjects = await listProjects("kickoff_pending");
  for (const project of kickoffProjects) {
    try {
      await setProjectStatus(project.slug, "kickoff_in_progress");
      const councilId = `council-kickoff-${randomUUID()}`;
      await spawnCouncilForKickoff(
        project.slug,
        project.path,
        councilId,
        deps,
        async (result) => {
          if (result.success) {
            kickoffFailures.delete(project.slug);
            return;
          }
          const failures = (kickoffFailures.get(project.slug) ?? 0) + 1;
          kickoffFailures.set(project.slug, failures);
          if (failures >= MAX_KICKOFF_ATTEMPTS) {
            console.error(`[Scheduler] Kickoff failed ${failures} times for ${project.slug} — marking kickoff_failed`);
            await setProjectStatus(project.slug, "kickoff_failed");
            await notifyKickoffFailed(project.slug, failures);
            kickoffFailures.delete(project.slug);
          } else {
            console.error(`[Scheduler] Kickoff failed for ${project.slug} (attempt ${failures}/${MAX_KICKOFF_ATTEMPTS}) — requeueing`);
            await setProjectStatus(project.slug, "kickoff_pending");
          }
        },
      );
    } catch (err: unknown) {
      console.error(`[Scheduler] Failed to spawn kickoff agent for ${project.slug}:`, err);
      const failures = (kickoffFailures.get(project.slug) ?? 0) + 1;
      kickoffFailures.set(project.slug, failures);
      if (failures >= MAX_KICKOFF_ATTEMPTS) {
        await setProjectStatus(project.slug, "kickoff_failed");
        await notifyKickoffFailed(project.slug, failures);
        kickoffFailures.delete(project.slug);
      } else {
        await setProjectStatus(project.slug, "kickoff_pending");
      }
    }
  }

  const registry = await readRegistry();
  await scanOrphanedReviewTasks(registry, deps);

  // Check for silent/stuck agents
  if (deps.heartbeatTimeoutMs !== undefined && deps.heartbeatTimeoutMs > 0) {
    await checkStaleAgents(registry, deps.heartbeatTimeoutMs);
  }

  const pending = await scanPendingTasks();
  if (pending.length === 0) return;

  const activeAgentCount = Object.keys(registry).length;

  // Simple global capacity check — prevent spawning too many agents at once
  if (activeAgentCount >= MAX_CONCURRENT_AGENTS) return;

  // ── Global budget check (once per cycle) ────────────────────────────────────
  if (deps.budget?.global_usd !== undefined) {
    const globalTotal = await getGlobalCostTotal();
    if (globalTotal >= deps.budget.global_usd) {
      if (!notifiedGlobalBudget) {
        notifiedGlobalBudget = true;
        console.warn(
          `[Scheduler] Global spend $${globalTotal.toFixed(4)} has reached the ` +
          `$${deps.budget.global_usd.toFixed(2)} budget cap — no new agents will be spawned.`,
        );
      }
      return;
    } else {
      notifiedGlobalBudget = false; // reset if budget recovered (e.g. cap raised)
    }
  }

  // Per-project agent counts for the per-project cap
  const agentsByProject = new Map<string, number>();
  if (deps.maxAgentsPerProject !== undefined) {
    for (const identity of Object.values(registry)) {
      if (identity.project_slug !== undefined) {
        agentsByProject.set(
          identity.project_slug,
          (agentsByProject.get(identity.project_slug) ?? 0) + 1,
        );
      }
    }
  }

  // Build dependency graph once for cycle detection (lazy — only if needed)
  let depGraph: Map<string, readonly string[]> | null = null;

  for (const task of pending) {
    if (task.frontmatter.status === "assigned") {
      const alive =
        task.frontmatter.assigned_crafter !== null &&
        registry[task.frontmatter.assigned_crafter] !== undefined;
      if (alive) continue;

      // Grace period: a freshly-assigned task may not have had time to register
      // in live.json yet. The scheduler runs every 500ms; registration requires
      // acquiring the live.json file lock which may queue behind other agents.
      // Treat as orphaned only once the assignment is at least 30 seconds old.
      const assignedAgeMs = Date.now() - new Date(task.frontmatter.updated_at).getTime();
      if (assignedAgeMs < CRAFTER_REGISTRATION_GRACE_MS) continue;

      // Re-read body and check for a pending sentinel before resetting.
      // If a sentinel is present, the file watcher will apply the transition —
      // do not stomp it with an orphan reset.
      const freshDoc = await readMarkdownFile<TaskFrontmatter>(task.filePath);
      if (freshDoc !== null) {
        const pendingTransition = evaluateTransitions(
          freshDoc.frontmatter.status,
          freshDoc.body,
          freshDoc.frontmatter,
        );
        if (pendingTransition !== null) {
          console.log(`[Scheduler] Sentinel present in assigned task — skipping orphan reset: ${task.filePath}`);
          continue;
        }
      }

      await resetOrphanedTask(task.filePath);
      continue;
    }

    if (task.frontmatter.status !== "pending") continue;
    if (task.frontmatter.blocked_by.length > 0) {
      const resolved = await dependenciesResolved(task);
      if (!resolved) continue;
    }

    // Per-project agent cap
    if (deps.maxAgentsPerProject !== undefined) {
      const projectCount = agentsByProject.get(task.frontmatter.project) ?? 0;
      if (projectCount >= deps.maxAgentsPerProject) continue;
    }

    // Per-project budget check
    if (deps.budget?.per_project_usd !== undefined) {
      const projectTotal = await getProjectCostTotal(task.frontmatter.project);
      if (projectTotal >= deps.budget.per_project_usd) {
        if (!notifiedOverBudget.has(task.frontmatter.project)) {
          notifiedOverBudget.add(task.frontmatter.project);
          console.warn(
            `[Scheduler] Project ${task.frontmatter.project} spend $${projectTotal.toFixed(4)} has reached the ` +
            `$${deps.budget.per_project_usd.toFixed(2)} per-project budget cap — no new agents will be spawned for this project.`,
          );
        }
        continue;
      } else {
        notifiedOverBudget.delete(task.frontmatter.project);
      }
    }

    // Circular dependency detection — build graph on first use.
    // A task with no blocked_by entries has no outgoing edges in the
    // dependency graph and therefore cannot participate in a cycle.
    if (task.frontmatter.blocked_by.length > 0) {
      if (depGraph === null) depGraph = await buildDependencyGraph();
      if (hasCycle(task.frontmatter.id, depGraph)) {
        const cycleKey = task.frontmatter.id;
        if (!notifiedCycles.has(cycleKey)) {
          notifiedCycles.add(cycleKey);
          console.error(
            `[Scheduler] Circular dependency detected: ${task.frontmatter.id} — blocking task`,
          );
          // Mark the task blocked so it doesn't loop through the scheduler forever
          const doc = await readMarkdownFile<TaskFrontmatter>(task.filePath);
          if (doc !== null) {
            await writeMarkdownFile(task.filePath, {
              ...doc.frontmatter,
              status: "blocked",
              updated_at: new Date().toISOString(),
            }, doc.body + "\n\n## Scheduler Note\n\nTask blocked: circular dependency detected in `blocked_by` graph.\n");
          }
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          await writeFile(
            `state/inbox/tarantoga/unread/cycle-${sanitizePathSegment(task.frontmatter.id)}-${ts}.md`,
            [
              `## Circular Dependency Detected`,
              "",
              `Task \`${task.frontmatter.id}\` (project: ${task.frontmatter.project}) has a circular dependency in its \`blocked_by\` graph.`,
              "",
              `The task has been set to \`blocked\`. Manual intervention required.`,
              "",
              `**Detected at:** ${new Date().toISOString()}`,
            ].join("\n"),
          );
        }
        continue;
      }
    }

    const crafterAgentId = `crafter-${randomUUID()}`;
    const projectPath = task.frontmatter.project_path ?? process.cwd();

    // Mark as assigned before spawning
    const updated: TaskFrontmatter = {
      ...task.frontmatter,
      status: "assigned",
      assigned_crafter: crafterAgentId,
      updated_at: new Date().toISOString(),
    };

    // We need the body to re-write — fetch it
    const doc = await readMarkdownFile<TaskFrontmatter>(task.filePath);
    if (doc === null) continue;

    await writeMarkdownFile(
      task.filePath,
      updated,
      doc.body,
    );

    await spawnCrafter(
      task.filePath,
      task.frontmatter.project,
      projectPath,
      task.frontmatter.crafter_type,
      crafterAgentId,
      deps,
      deps.onAgentResult,
    );

    break; // One spawn per cycle to avoid thundering herd
  }
}
