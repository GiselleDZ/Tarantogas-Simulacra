import type { TaskStatus, TaskFrontmatter, TransitionRule } from "../types/index.js";
import { readMarkdownFile, writeMarkdownFile } from "../io/fileStore.js";
import { FileLock } from "../io/lock.js";

// ── Transition Table ──────────────────────────────────────────────────────────
//
// This is the single authoritative definition of all valid task state
// transitions. The orchestrator evaluates this table when scanning task files —
// it never uses switch/case or ad-hoc logic to decide transitions.

export const TRANSITION_TABLE: readonly TransitionRule[] = [
  // Crafter picks up an assigned task
  {
    from: "assigned",
    to: "in_progress",
    sentinel: "STATUS_SIGNAL: in_progress",
    section: "## Crafter Work",
  },

  // Crafter signals work is ready for Steward review
  {
    from: "in_progress",
    to: "steward_review",
    sentinel: "STATUS_SIGNAL: ready_for_steward_review",
    section: "## Crafter Work",
  },

  // Steward requests revision
  {
    from: "steward_review",
    to: "crafter_revision",
    sentinel: "STATUS_SIGNAL: crafter_revision_requested",
    section: "## Steward Review",
  },

  // Crafter signals revised work is ready for final review
  {
    from: "crafter_revision",
    to: "steward_final",
    sentinel: "STATUS_SIGNAL: ready_for_steward_review",
    section: "## Crafter Work",
    requiredField: "assigned_crafter",
  },

  // Steward final sign-off — drift cleared, proceed to compound
  {
    from: "steward_final",
    to: "compound",
    sentinel: "STATUS_SIGNAL: ready_for_compound",
    section: "## Steward Final",
    requiredField: "assigned_steward",
  },

  // Drift detected during Steward final review
  {
    from: "steward_final",
    to: "drift_detected",
    sentinel: "DRIFT_SIGNAL: FLAGGED",
    section: "## Steward Final",
  },

  // Drift cleared after investigation
  {
    from: "drift_detected",
    to: "drift_cleared",
    sentinel: "DRIFT_SIGNAL: CLEARED",
    section: "## Steward Final",
  },

  // After drift cleared, proceed to compound
  {
    from: "drift_cleared",
    to: "compound",
    sentinel: "STATUS_SIGNAL: ready_for_compound",
    section: "## Steward Final",
  },

  // Council completes the Compound step
  {
    from: "compound",
    to: "council_review",
    sentinel: "COMPOUND_SIGNAL: complete",
    section: "## Compound Step",
    requiredField: "assigned_council_author",
  },

  // Council author approves
  {
    from: "council_review",
    to: "council_peer_review",
    sentinel: "COUNCIL_SIGNAL: APPROVED",
    section: "## Council Review",
    requiredField: "assigned_council_author",
  },

  // Council author requests revision (sends back to Crafter)
  {
    from: "council_review",
    to: "crafter_revision",
    sentinel: "COUNCIL_SIGNAL: REVISION_REQUIRED",
    section: "## Council Review",
  },

  // Council peer approves — task is done
  {
    from: "council_peer_review",
    to: "done",
    sentinel: "COUNCIL_SIGNAL: APPROVED",
    section: "## Council Peer Review",
    requiredField: "assigned_council_peer",
  },

  // Council peer requests revision
  {
    from: "council_peer_review",
    to: "crafter_revision",
    sentinel: "COUNCIL_SIGNAL: REVISION_REQUIRED",
    section: "## Council Peer Review",
  },
];

// ── Section Parsing ───────────────────────────────────────────────────────────

/** Extract the content of a named section from a markdown body. */
function extractSection(body: string, sectionHeader: string): string {
  const headerIndex = body.indexOf(sectionHeader);
  if (headerIndex === -1) return "";

  const contentStart = headerIndex + sectionHeader.length;
  const nextHeaderMatch = body.slice(contentStart).match(/\n## /);
  const contentEnd =
    nextHeaderMatch?.index !== undefined
      ? contentStart + nextHeaderMatch.index
      : body.length;

  return body.slice(contentStart, contentEnd);
}

/** Check whether a sentinel string appears in the given section content. */
function sectionContainsSentinel(
  sectionContent: string,
  sentinel: string,
): boolean {
  return sectionContent.includes(sentinel);
}

// ── Transition Evaluation ─────────────────────────────────────────────────────

export interface TransitionMatch {
  readonly rule: TransitionRule;
  readonly newStatus: TaskStatus;
}

/**
 * Evaluate the transition table against a task file body and current status.
 * Returns the first matching transition, or null if no sentinel is found.
 */
export function evaluateTransitions(
  currentStatus: TaskStatus,
  body: string,
  frontmatter: TaskFrontmatter,
): TransitionMatch | null {
  const candidateRules = TRANSITION_TABLE.filter(
    (rule) => rule.from === currentStatus,
  );

  for (const rule of candidateRules) {
    const sectionContent = extractSection(body, rule.section);
    if (!sectionContainsSentinel(sectionContent, rule.sentinel)) {
      continue;
    }

    // Validate required field is set
    if (rule.requiredField !== undefined) {
      const fieldValue = frontmatter[rule.requiredField];
      if (fieldValue === null || fieldValue === undefined) {
        console.warn(
          `[Pipeline] Sentinel found for ${rule.from} → ${rule.to} but required field ` +
            `'${String(rule.requiredField)}' is not set. Transition blocked.`,
        );
        continue;
      }
    }

    return { rule, newStatus: rule.to };
  }

  return null;
}

// ── Orchestrator API ──────────────────────────────────────────────────────────

/**
 * Scan a task file and apply any pending transition.
 * The orchestrator calls this whenever a task file changes.
 * Returns the new status if a transition was applied, null otherwise.
 */
export async function applyPendingTransition(
  taskFilePath: string,
): Promise<TaskStatus | null> {
  const lock = new FileLock(taskFilePath);

  return lock.withLock(async () => {
    const doc = await readMarkdownFile<TaskFrontmatter>(taskFilePath);
    if (doc === null) return null;

    const { frontmatter, body } = doc;
    const match = evaluateTransitions(frontmatter.status, body, frontmatter);
    if (match === null) return null;

    const updatedFrontmatter: TaskFrontmatter = {
      ...frontmatter,
      status: match.newStatus,
      updated_at: new Date().toISOString(),
    };

    await writeMarkdownFile(taskFilePath, updatedFrontmatter, body);

    return match.newStatus;
  });
}
