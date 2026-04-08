import { describe, it, expect } from "vitest";
import {
  TRANSITION_TABLE,
  evaluateTransitions,
  scrubSentinels,
} from "./taskPipeline.js";
import { makeTaskFrontmatter } from "../test/fixtures.js";
import type { TaskStatus } from "../types/index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a markdown body with the given sentinel in the given section. */
function bodyWith(section: string, sentinel: string, extra = ""): string {
  return `${section}\n\nSome preceding text.\n\n${sentinel}\n${extra}`;
}

/** Build a body with multiple sections. */
function multiSectionBody(
  entries: Array<{ section: string; content: string }>,
): string {
  return entries.map((e) => `${e.section}\n\n${e.content}\n`).join("\n");
}

// ── Suite 2a: Transition Table Invariants ───────────────────────────────────

const ALL_STATUSES: TaskStatus[] = [
  "pending", "research_pending", "research_review", "assigned",
  "in_progress", "steward_review", "crafter_revision", "steward_final",
  "drift_detected", "drift_cleared", "compound", "council_review",
  "council_peer_review", "done", "blocked", "cancelled",
];

describe("TRANSITION_TABLE invariants", () => {
  it("has 18 rules", () => {
    expect(TRANSITION_TABLE.length).toBe(18);
  });

  it("every 'from' status is a valid TaskStatus", () => {
    for (const rule of TRANSITION_TABLE) {
      expect(ALL_STATUSES).toContain(rule.from);
    }
  });

  it("every 'to' status is a valid TaskStatus", () => {
    for (const rule of TRANSITION_TABLE) {
      expect(ALL_STATUSES).toContain(rule.to);
    }
  });

  it("has no duplicate (from, sentinel) pairs", () => {
    const seen = new Set<string>();
    for (const rule of TRANSITION_TABLE) {
      const key = `${rule.from}|${rule.sentinel}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

// ── Suite 2b: evaluateTransitions — Happy Path per Rule ─────────────────────

describe("evaluateTransitions — happy path for every rule", () => {
  it("pending → research_pending", () => {
    const fm = makeTaskFrontmatter({ status: "pending" });
    const body = bodyWith("## Council Research", "RESEARCH_SIGNAL: commissioned");
    const match = evaluateTransitions("pending", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("research_pending");
  });

  it("research_pending → research_review", () => {
    const fm = makeTaskFrontmatter({ status: "research_pending" });
    const body = bodyWith("## Research Output", "RESEARCH_SIGNAL: complete");
    const match = evaluateTransitions("research_pending", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("research_review");
  });

  it("research_review → pending", () => {
    const fm = makeTaskFrontmatter({ status: "research_review" });
    const body = bodyWith("## Council Research Review", "RESEARCH_SIGNAL: approved");
    const match = evaluateTransitions("research_review", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("pending");
  });

  it("assigned → in_progress", () => {
    const fm = makeTaskFrontmatter({ status: "assigned" });
    const body = bodyWith("## Crafter Work", "STATUS_SIGNAL: in_progress");
    const match = evaluateTransitions("assigned", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("in_progress");
  });

  it("assigned → steward_review", () => {
    const fm = makeTaskFrontmatter({ status: "assigned" });
    const body = bodyWith("## Crafter Work", "STATUS_SIGNAL: ready_for_steward_review");
    const match = evaluateTransitions("assigned", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("steward_review");
  });

  it("in_progress → steward_review", () => {
    const fm = makeTaskFrontmatter({ status: "in_progress" });
    const body = bodyWith("## Crafter Work", "STATUS_SIGNAL: ready_for_steward_review");
    const match = evaluateTransitions("in_progress", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("steward_review");
  });

  it("steward_review → steward_final (requires assigned_steward)", () => {
    const fm = makeTaskFrontmatter({
      status: "steward_review",
      assigned_steward: "steward-001",
    });
    const body = bodyWith("## Steward Review", "STATUS_SIGNAL: ready_for_steward_final");
    const match = evaluateTransitions("steward_review", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("steward_final");
  });

  it("steward_review → crafter_revision", () => {
    const fm = makeTaskFrontmatter({ status: "steward_review" });
    const body = bodyWith("## Steward Review", "STATUS_SIGNAL: crafter_revision_requested");
    const match = evaluateTransitions("steward_review", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("crafter_revision");
  });

  it("crafter_revision → steward_final (requires assigned_crafter)", () => {
    const fm = makeTaskFrontmatter({
      status: "crafter_revision",
      assigned_crafter: "crafter-001",
    });
    const body = bodyWith("## Crafter Work", "STATUS_SIGNAL: ready_for_steward_review");
    const match = evaluateTransitions("crafter_revision", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("steward_final");
  });

  it("steward_final → compound (requires assigned_steward)", () => {
    const fm = makeTaskFrontmatter({
      status: "steward_final",
      assigned_steward: "steward-001",
    });
    const body = bodyWith("## Steward Final", "STATUS_SIGNAL: ready_for_compound");
    const match = evaluateTransitions("steward_final", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("compound");
  });

  it("steward_final → drift_detected", () => {
    const fm = makeTaskFrontmatter({ status: "steward_final" });
    const body = bodyWith("## Steward Final", "DRIFT_SIGNAL: FLAGGED");
    const match = evaluateTransitions("steward_final", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("drift_detected");
  });

  it("drift_detected → drift_cleared", () => {
    const fm = makeTaskFrontmatter({ status: "drift_detected" });
    const body = bodyWith("## Steward Final", "DRIFT_SIGNAL: CLEARED");
    const match = evaluateTransitions("drift_detected", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("drift_cleared");
  });

  it("drift_cleared → compound", () => {
    const fm = makeTaskFrontmatter({ status: "drift_cleared" });
    const body = bodyWith("## Steward Final", "STATUS_SIGNAL: ready_for_compound");
    const match = evaluateTransitions("drift_cleared", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("compound");
  });

  it("compound → council_review (requires assigned_council_author)", () => {
    const fm = makeTaskFrontmatter({
      status: "compound",
      assigned_council_author: "council-001",
    });
    const body = bodyWith("## Compound Step", "COMPOUND_SIGNAL: complete");
    const match = evaluateTransitions("compound", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("council_review");
  });

  it("council_review → council_peer_review (requires assigned_council_author)", () => {
    const fm = makeTaskFrontmatter({
      status: "council_review",
      assigned_council_author: "council-001",
    });
    const body = bodyWith("## Council Review", "COUNCIL_SIGNAL: APPROVED");
    const match = evaluateTransitions("council_review", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("council_peer_review");
  });

  it("council_review → crafter_revision (revision required)", () => {
    const fm = makeTaskFrontmatter({ status: "council_review" });
    const body = bodyWith("## Council Review", "COUNCIL_SIGNAL: REVISION_REQUIRED");
    const match = evaluateTransitions("council_review", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("crafter_revision");
  });

  it("council_peer_review → done (requires assigned_council_peer)", () => {
    const fm = makeTaskFrontmatter({
      status: "council_peer_review",
      assigned_council_peer: "council-peer-001",
    });
    const body = bodyWith("## Council Peer Review", "COUNCIL_SIGNAL: APPROVED");
    const match = evaluateTransitions("council_peer_review", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("done");
  });

  it("council_peer_review → crafter_revision (revision required)", () => {
    const fm = makeTaskFrontmatter({ status: "council_peer_review" });
    const body = bodyWith("## Council Peer Review", "COUNCIL_SIGNAL: REVISION_REQUIRED");
    const match = evaluateTransitions("council_peer_review", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("crafter_revision");
  });
});

// ── Suite 2c: evaluateTransitions — Edge Cases ──────────────────────────────

describe("evaluateTransitions — edge cases", () => {
  it("returns null when sentinel is in wrong section", () => {
    const fm = makeTaskFrontmatter({ status: "pending" });
    // Sentinel for pending→research_pending should be in ## Council Research, not ## Crafter Work
    const body = bodyWith("## Crafter Work", "RESEARCH_SIGNAL: commissioned");
    expect(evaluateTransitions("pending", body, fm)).toBeNull();
  });

  it("returns null when current status doesn't match any rule's from", () => {
    const fm = makeTaskFrontmatter({ status: "done" });
    const body = bodyWith("## Crafter Work", "STATUS_SIGNAL: in_progress");
    expect(evaluateTransitions("done", body, fm)).toBeNull();
  });

  it("returns null when required field is missing", () => {
    // crafter_revision → steward_final requires assigned_crafter
    const fm = makeTaskFrontmatter({
      status: "crafter_revision",
      assigned_crafter: null,
    });
    const body = bodyWith("## Crafter Work", "STATUS_SIGNAL: ready_for_steward_review");
    expect(evaluateTransitions("crafter_revision", body, fm)).toBeNull();
  });

  it("returns null for empty body", () => {
    const fm = makeTaskFrontmatter({ status: "assigned" });
    expect(evaluateTransitions("assigned", "", fm)).toBeNull();
  });

  it("sentinel in body text (not in any section) → null", () => {
    const fm = makeTaskFrontmatter({ status: "assigned" });
    // Sentinel exists but not under any ## heading that matches
    const body = "Just a free-floating STATUS_SIGNAL: in_progress without a section header.";
    expect(evaluateTransitions("assigned", body, fm)).toBeNull();
  });

  it("first matching rule wins when multiple could match", () => {
    // For assigned status: both in_progress and steward_review transitions exist.
    // TRANSITION_TABLE has in_progress first, so with that sentinel, it should match first.
    const fm = makeTaskFrontmatter({ status: "assigned" });
    const body = bodyWith("## Crafter Work", "STATUS_SIGNAL: in_progress");
    const match = evaluateTransitions("assigned", body, fm);
    expect(match!.newStatus).toBe("in_progress");
  });
});

// ── Suite 2d: Section extraction with agent sub-headers ─────────────────────

describe("evaluateTransitions — agent-written sub-headers inside sections", () => {
  it("research_pending → research_review when ## Research Output contains ## sub-headers", () => {
    const fm = makeTaskFrontmatter({ status: "research_pending" });
    const body = [
      "## Research Output",
      "",
      "PHASE: starting research",
      "",
      "## Summary",
      "Research found important things about validation patterns.",
      "",
      "## Evidence",
      "Evidence details: Chakra UI v3 Field component supports maxLength natively.",
      "",
      "## Gaps and Uncertainties",
      "No gaps identified.",
      "",
      "## Recommendation",
      "Use dual enforcement: HTML maxLength + JS submit guard.",
      "",
      "RESEARCH_SIGNAL: complete",
      "",
      "## Crafter Work",
      "",
    ].join("\n");
    const match = evaluateTransitions("research_pending", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("research_review");
  });

  it("sentinel in section with sub-headers but no following task section is found", () => {
    const fm = makeTaskFrontmatter({ status: "research_pending" });
    // No ## Crafter Work after — sentinel should still be found at end of body
    const body = [
      "## Research Output",
      "",
      "## Summary",
      "Findings here.",
      "",
      "RESEARCH_SIGNAL: complete",
    ].join("\n");
    const match = evaluateTransitions("research_pending", body, fm);
    expect(match).not.toBeNull();
    expect(match!.newStatus).toBe("research_review");
  });

  it("known task section headers still correctly terminate sections", () => {
    const fm = makeTaskFrontmatter({ status: "research_pending" });
    // Sentinel is in ## Crafter Work, NOT in ## Research Output
    const body = [
      "## Research Output",
      "",
      "No sentinel here.",
      "",
      "## Crafter Work",
      "",
      "RESEARCH_SIGNAL: complete",
    ].join("\n");
    const match = evaluateTransitions("research_pending", body, fm);
    // Should NOT match — sentinel is in wrong section
    expect(match).toBeNull();
  });
});

// ── Suite 2e: scrubSentinels ────────────────────────────────────────────────

describe("scrubSentinels", () => {
  it("replaces all known sentinel types", () => {
    const sentinels = [
      "STATUS_SIGNAL: ready_for_steward_review",
      "STATUS_SIGNAL: ready_for_steward_final",
      "STATUS_SIGNAL: in_progress",
      "STATUS_SIGNAL: crafter_revision_requested",
      "STATUS_SIGNAL: ready_for_compound",
      "DRIFT_SIGNAL: FLAGGED",
      "DRIFT_SIGNAL: CLEARED",
      "COMPOUND_SIGNAL: complete",
      "COUNCIL_SIGNAL: APPROVED",
      "COUNCIL_SIGNAL: REVISION_REQUIRED",
      "RESEARCH_SIGNAL: commissioned",
      "RESEARCH_SIGNAL: complete",
      "RESEARCH_SIGNAL: approved",
    ];
    const body = sentinels.join("\n");
    const scrubbed = scrubSentinels(body);
    for (const s of sentinels) {
      expect(scrubbed).not.toContain(s);
    }
    expect(scrubbed).toContain("[sentinel cleared]");
  });

  it("replaces multiple occurrences of the same sentinel", () => {
    const body = "STATUS_SIGNAL: in_progress\nsome text\nSTATUS_SIGNAL: in_progress\n";
    const scrubbed = scrubSentinels(body);
    expect(scrubbed).not.toContain("STATUS_SIGNAL: in_progress");
    expect(scrubbed.match(/\[sentinel cleared\]/g)?.length).toBe(2);
  });

  it("leaves non-sentinel text untouched", () => {
    const body = "This is regular text that should not be modified.";
    expect(scrubSentinels(body)).toBe(body);
  });

  it("handles empty body", () => {
    expect(scrubSentinels("")).toBe("");
  });
});

// ── Suite 2f: Full Lifecycle Integration ────────────────────────────────────

describe("full task lifecycle — pending through done", () => {
  it("walks a task through the complete happy path", () => {
    // Start with a pending task
    let status: TaskStatus = "pending";
    let body = "";
    const fm = makeTaskFrontmatter({ status: "pending" });

    // Helper to step through a transition
    const step = (
      section: string,
      sentinel: string,
      fmOverrides: Partial<typeof fm> = {},
    ): TaskStatus => {
      body += `\n\n${section}\n\n${sentinel}\n`;
      const merged = { ...fm, ...fmOverrides, status };
      const match = evaluateTransitions(status, body, merged);
      expect(match).not.toBeNull();
      return match!.newStatus;
    };

    // pending → research_pending
    status = step("## Council Research", "RESEARCH_SIGNAL: commissioned");
    expect(status).toBe("research_pending");

    // research_pending → research_review
    status = step("## Research Output", "RESEARCH_SIGNAL: complete");
    expect(status).toBe("research_review");

    // research_review → pending
    status = step("## Council Research Review", "RESEARCH_SIGNAL: approved");
    expect(status).toBe("pending");

    // pending → assigned (done by scheduler, not a sentinel)
    status = "assigned";

    // assigned → in_progress
    status = step("## Crafter Work", "STATUS_SIGNAL: in_progress");
    expect(status).toBe("in_progress");

    // in_progress → steward_review
    status = step("## Crafter Work", "STATUS_SIGNAL: ready_for_steward_review");
    expect(status).toBe("steward_review");

    // steward_review → crafter_revision
    status = step("## Steward Review", "STATUS_SIGNAL: crafter_revision_requested");
    expect(status).toBe("crafter_revision");

    // crafter_revision → steward_final (requires assigned_crafter)
    status = step("## Crafter Work", "STATUS_SIGNAL: ready_for_steward_review", {
      assigned_crafter: "crafter-001",
    });
    expect(status).toBe("steward_final");

    // steward_final → compound (requires assigned_steward)
    status = step("## Steward Final", "STATUS_SIGNAL: ready_for_compound", {
      assigned_steward: "steward-001",
    });
    expect(status).toBe("compound");

    // compound → council_review (requires assigned_council_author)
    status = step("## Compound Step", "COMPOUND_SIGNAL: complete", {
      assigned_council_author: "council-001",
    });
    expect(status).toBe("council_review");

    // council_review → council_peer_review (requires assigned_council_author)
    status = step("## Council Review", "COUNCIL_SIGNAL: APPROVED", {
      assigned_council_author: "council-001",
    });
    expect(status).toBe("council_peer_review");

    // council_peer_review → done (requires assigned_council_peer)
    status = step("## Council Peer Review", "COUNCIL_SIGNAL: APPROVED", {
      assigned_council_peer: "council-peer-001",
    });
    expect(status).toBe("done");
  });
});
