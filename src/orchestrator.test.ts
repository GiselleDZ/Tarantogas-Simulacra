import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

/**
 * Source-level contract tests for handleTransition in orchestrator.ts.
 *
 * These verify that the agent-ID-reuse pattern (`assigned_* ?? randomUUID()`)
 * is applied consistently, and that `crafter_revision` is actually handled.
 *
 * We read the source text directly rather than executing handleTransition,
 * because handleTransition has deep side effects (spawning subprocesses,
 * filesystem writes) that are impractical to mock at the orchestrator level.
 * The spawn helpers themselves are tested in agentSpawns.test.ts.
 */

const orchestratorSource = readFileSync(
  path.resolve(__dirname, "orchestrator.ts"),
  "utf-8",
);

/**
 * Extract the body of handleTransition from the source.
 * Finds `async function handleTransition` and captures everything up to the
 * next top-level `async function` or end of file.
 */
function getHandleTransitionBody(): string {
  const startMarker = "async function handleTransition";
  const startIdx = orchestratorSource.indexOf(startMarker);
  if (startIdx === -1) throw new Error("handleTransition not found in orchestrator.ts");

  // Find the next top-level function declaration after handleTransition
  const afterStart = orchestratorSource.slice(startIdx + startMarker.length);
  const nextFnMatch = afterStart.match(/\n(?:async )?function \w+/);
  const body = nextFnMatch
    ? orchestratorSource.slice(startIdx, startIdx + startMarker.length + nextFnMatch.index!)
    : orchestratorSource.slice(startIdx);
  return body;
}

describe("handleTransition agent ID reuse contracts", () => {
  const body = getHandleTransitionBody();

  it("every randomUUID() in handleTransition has a ?? fallback from frontmatter (except research_pending)", () => {
    // Find all lines containing randomUUID() in the function body
    const lines = body.split("\n");
    const uuidLines = lines.filter((line) => line.includes("randomUUID()"));

    expect(uuidLines.length).toBeGreaterThan(0);

    for (const line of uuidLines) {
      // research_pending is intentionally exempt — research agents are one-shot
      // and have no assigned_research field in frontmatter.
      if (line.includes("researchId")) continue;

      // Each randomUUID() should be preceded by `?? ` on the same line,
      // meaning it's the fallback side of a nullish coalescing expression.
      expect(line).toMatch(
        /frontmatter\.assigned_\w+\s*\?\?\s*`\w+-\$\{randomUUID\(\)\}`/,
      );
    }
  });

  it("research_review uses assigned_council_author ?? (not bare randomUUID)", () => {
    // Find the research_review case
    const researchReviewMatch = body.match(
      /case\s+"research_review"[\s\S]*?break;/,
    );
    expect(researchReviewMatch).not.toBeNull();
    const caseBody = researchReviewMatch![0];

    expect(caseBody).toContain("frontmatter.assigned_council_author");
    expect(caseBody).toContain("??");
    // Should NOT have a bare `council-${randomUUID()}` without ??
    expect(caseBody).not.toMatch(
      /const\s+councilId\s*=\s*`council-\$\{randomUUID\(\)\}`/,
    );
  });

  it("steward_review uses assigned_steward ?? (not bare randomUUID)", () => {
    const match = body.match(/case\s+"steward_review"[\s\S]*?break;/);
    expect(match).not.toBeNull();
    const caseBody = match![0];

    expect(caseBody).toContain("frontmatter.assigned_steward");
    expect(caseBody).toContain("??");
    expect(caseBody).not.toMatch(
      /const\s+stewardId\s*=\s*`steward-\$\{randomUUID\(\)\}`/,
    );
  });

  it("steward_final uses assigned_steward ?? (not bare randomUUID)", () => {
    const match = body.match(/case\s+"steward_final"[\s\S]*?break;/);
    expect(match).not.toBeNull();
    const caseBody = match![0];

    expect(caseBody).toContain("frontmatter.assigned_steward");
    expect(caseBody).toContain("??");
    expect(caseBody).not.toMatch(
      /const\s+stewardId\s*=\s*`steward-\$\{randomUUID\(\)\}`/,
    );
  });

  it("crafter_revision case exists and calls spawnCrafterForRevision", () => {
    expect(body).toMatch(/case\s+"crafter_revision"/);
    expect(body).toContain("spawnCrafterForRevision");
  });

  it("default case does not mention crafter_revision", () => {
    const defaultMatch = body.match(/default:\s*\n\s*\/\/[^\n]*/);
    expect(defaultMatch).not.toBeNull();
    expect(defaultMatch![0]).not.toContain("crafter_revision");
  });
});
