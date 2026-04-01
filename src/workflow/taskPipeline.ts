import type { TaskStatus, TaskFrontmatter, TransitionRule } from "../types/index.js";
import { readMarkdownFile, writeMarkdownFile, writeFile } from "../io/fileStore.js";
import { FileLock } from "../io/lock.js";

// ── Transition Table ──────────────────────────────────────────────────────────
//
// This is the single authoritative definition of all valid task state
// transitions. The orchestrator evaluates this table when scanning task files —
// it never uses switch/case or ad-hoc logic to decide transitions.

export const TRANSITION_TABLE: readonly TransitionRule[] = [
  // Council commissions research before assigning a task
  {
    from: "pending",
    to: "research_pending",
    sentinel: "RESEARCH_SIGNAL: commissioned",
    section: "## Council Research",
  },

  // Research agent signals that findings are written
  {
    from: "research_pending",
    to: "research_review",
    sentinel: "RESEARCH_SIGNAL: complete",
    section: "## Research Output",
  },

  // Council reviews research and clears task for Crafter assignment
  {
    from: "research_review",
    to: "pending",
    sentinel: "RESEARCH_SIGNAL: approved",
    section: "## Council Research Review",
  },

  // Crafter picks up an assigned task
  {
    from: "assigned",
    to: "in_progress",
    sentinel: "STATUS_SIGNAL: in_progress",
    section: "## Crafter Work",
  },

  // Fast-path: if Crafter skips the in_progress signal, allow direct assigned → steward_review
  {
    from: "assigned",
    to: "steward_review",
    sentinel: "STATUS_SIGNAL: ready_for_steward_review",
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

/** Extract the content of a named section from a markdown body.
 *  Concatenates ALL occurrences — a section may appear more than once
 *  (e.g. multiple crafter work blocks appended to the same task file).
 */
function extractSection(body: string, sectionHeader: string): string {
  const segments: string[] = [];
  let searchFrom = 0;

  while (true) {
    const headerIndex = body.indexOf(sectionHeader, searchFrom);
    if (headerIndex === -1) break;

    const contentStart = headerIndex + sectionHeader.length;
    const nextHeaderMatch = body.slice(contentStart).match(/\n## /);
    const contentEnd =
      nextHeaderMatch?.index !== undefined
        ? contentStart + nextHeaderMatch.index
        : body.length;

    segments.push(body.slice(contentStart, contentEnd));
    searchFrom = contentEnd;
  }

  return segments.join("\n");
}

/** Check whether a sentinel string appears in the given section content. */
function sectionContainsSentinel(
  sectionContent: string,
  sentinel: string,
): boolean {
  return sectionContent.includes(sentinel);
}

/**
 * Clear a sentinel from the body so it cannot re-trigger a transition.
 * Targets the last occurrence of the sentinel within the last occurrence
 * of the matching section. Replaces the sentinel with a timestamped annotation
 * that does not contain the sentinel as a substring, so future includes() checks
 * will not match.
 */
function clearSentinel(body: string, section: string, sentinel: string): string {
  // Find the last occurrence of the section header
  let lastSectionStart = -1;
  let searchFrom = 0;
  while (true) {
    const idx = body.indexOf(section, searchFrom);
    if (idx === -1) break;
    lastSectionStart = idx;
    searchFrom = idx + 1;
  }
  if (lastSectionStart === -1) return body;

  // Determine the end of the last section
  const contentStart = lastSectionStart + section.length;
  const nextHeaderMatch = body.slice(contentStart).match(/\n## /);
  const sectionEnd =
    nextHeaderMatch?.index !== undefined
      ? contentStart + nextHeaderMatch.index
      : body.length;

  // Find the last occurrence of the sentinel within this section
  const sectionSlice = body.slice(lastSectionStart, sectionEnd);
  const lastSentinelIdx = sectionSlice.lastIndexOf(sentinel);
  if (lastSentinelIdx === -1) return body;

  const annotation = `[transitioned: ${new Date().toISOString()}]`;
  const clearedSection =
    sectionSlice.slice(0, lastSentinelIdx) +
    annotation +
    sectionSlice.slice(lastSentinelIdx + sentinel.length);

  return body.slice(0, lastSectionStart) + clearedSection + body.slice(sectionEnd);
}

/**
 * Scrub all known sentinels from the body, replacing each with a neutral annotation
 * that does not contain the original sentinel as a substring.
 * Called when resetting a task to prevent stale sentinels from re-triggering transitions.
 */
export function scrubSentinels(body: string): string {
  let result = body;
  for (const rule of TRANSITION_TABLE) {
    result = result.replaceAll(rule.sentinel, "[sentinel cleared]");
  }
  return result;
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

// ── Section Archival ──────────────────────────────────────────────────────────

/**
 * Minimum section content length (chars) before archival is triggered.
 * Sections shorter than this are left in place — archiving tiny sections adds
 * overhead with no benefit.
 */
const ARCHIVE_THRESHOLD_CHARS = 3_000;

/**
 * Collapse all occurrences of a section header into a single archived stub.
 * Replaces every `## SectionName … (next ## header)` block with one entry
 * pointing at the archive file.
 */
function collapseSectionToStub(body: string, sectionHeader: string, stub: string): string {
  const firstIdx = body.indexOf(sectionHeader);
  if (firstIdx === -1) return body;

  // Find the end of the last occurrence of this section
  let lastOccurrenceEnd = firstIdx; // will be updated in the loop
  let searchFrom = 0;
  while (true) {
    const idx = body.indexOf(sectionHeader, searchFrom);
    if (idx === -1) break;
    const contentStart = idx + sectionHeader.length;
    const nextMatch = body.slice(contentStart).match(/\n## /);
    lastOccurrenceEnd = nextMatch?.index !== undefined
      ? contentStart + nextMatch.index
      : body.length;
    searchFrom = idx + 1;
  }

  return body.slice(0, firstIdx) + sectionHeader + stub + body.slice(lastOccurrenceEnd);
}

/**
 * If the completed section is large, archive its full content to state/archive/
 * and replace it with a one-line stub in the task body.
 * Returns the (possibly modified) body.
 */
async function maybeArchiveSection(
  taskId: string,
  sectionHeader: string,
  body: string,
): Promise<string> {
  const allContent = extractSection(body, sectionHeader);
  if (allContent.length < ARCHIVE_THRESHOLD_CHARS) return body;

  const sectionSlug = sectionHeader
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+$/, "");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = `state/archive/${taskId}/${sectionSlug}-${ts}.md`;

  await writeFile(
    archivePath,
    [
      `# Archive: ${sectionHeader.replace(/^#+\s*/, "")}`,
      "",
      `**Task:** \`${taskId}\`  **Archived:** ${new Date().toISOString()}`,
      "",
      "---",
      "",
      allContent.trim(),
      "",
    ].join("\n"),
  );

  const stub = `\n\n> *Archived at ${new Date().toISOString()} — [full content](../../${archivePath})*\n`;
  return collapseSectionToStub(body, sectionHeader, stub);
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

    const clearedBody = clearSentinel(body, match.rule.section, match.rule.sentinel);

    // Archive the completed section if it has grown large
    const archivedBody = await maybeArchiveSection(
      frontmatter.id,
      match.rule.section,
      clearedBody,
    );

    await writeMarkdownFile(taskFilePath, updatedFrontmatter, archivedBody);

    return match.newStatus;
  });
}
