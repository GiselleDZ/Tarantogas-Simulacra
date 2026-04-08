import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  similarityToDriftScore,
  scoreToDriftSeverity,
  severityToAction,
  embedResponses,
  extractProbeResponses,
  extractTaskConstraints,
} from "./driftMonitor.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for empty arrays", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 when one vector is all zeros", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe("similarityToDriftScore", () => {
  it("maps similarity 1 to drift 0", () => {
    expect(similarityToDriftScore(1)).toBe(0);
  });

  it("maps similarity 0 to drift 1", () => {
    expect(similarityToDriftScore(0)).toBe(1);
  });

  it("maps similarity 0.7 to drift 0.3", () => {
    expect(similarityToDriftScore(0.7)).toBeCloseTo(0.3);
  });

  it("clamps values above 1", () => {
    expect(similarityToDriftScore(1.5)).toBe(0);
  });

  it("clamps values below 0", () => {
    expect(similarityToDriftScore(-0.5)).toBe(1);
  });
});

describe("scoreToDriftSeverity", () => {
  const thresholds = {
    nominal_max: 0.2,
    monitor_max: 0.4,
    reinject_max: 0.6,
  };

  it("returns nominal for score below nominal_max", () => {
    expect(scoreToDriftSeverity(0.1, thresholds)).toBe("nominal");
  });

  it("returns monitor for score at nominal_max", () => {
    expect(scoreToDriftSeverity(0.2, thresholds)).toBe("monitor");
  });

  it("returns monitor for score between nominal and monitor", () => {
    expect(scoreToDriftSeverity(0.3, thresholds)).toBe("monitor");
  });

  it("returns reinject for score at monitor_max", () => {
    expect(scoreToDriftSeverity(0.4, thresholds)).toBe("reinject");
  });

  it("returns reinject for score between monitor and reinject", () => {
    expect(scoreToDriftSeverity(0.5, thresholds)).toBe("reinject");
  });

  it("returns halt for score at reinject_max", () => {
    expect(scoreToDriftSeverity(0.6, thresholds)).toBe("halt");
  });

  it("returns halt for score above reinject_max", () => {
    expect(scoreToDriftSeverity(0.9, thresholds)).toBe("halt");
  });
});

describe("severityToAction", () => {
  it("maps nominal to none", () => {
    expect(severityToAction("nominal")).toBe("none");
  });

  it("maps monitor to monitor", () => {
    expect(severityToAction("monitor")).toBe("monitor");
  });

  it("maps reinject to reinject_persona_anchor", () => {
    expect(severityToAction("reinject")).toBe("reinject_persona_anchor");
  });

  it("maps halt to halt_and_reset", () => {
    expect(severityToAction("halt")).toBe("halt_and_reset");
  });
});

describe("embedResponses", () => {
  it("produces a 256-dimension vector", async () => {
    const vector = await embedResponses(["hello world this is a test"]);
    expect(vector.length).toBe(256);
  });

  it("is deterministic — same input produces same output", async () => {
    const input = ["I am a council agent responsible for oversight"];
    const v1 = await embedResponses(input);
    const v2 = await embedResponses(input);
    expect(v1).toEqual(v2);
  });

  it("produces different output for different input", async () => {
    const v1 = await embedResponses(["I write code and build features"]);
    const v2 = await embedResponses(["I review quality and enforce standards"]);
    expect(v1).not.toEqual(v2);
  });

  it("filters out short words (< 3 chars)", async () => {
    // "a" and "is" should be filtered, so "a is test" ≈ just "test"
    const v1 = await embedResponses(["a is test"]);
    const v2 = await embedResponses(["test"]);
    expect(v1).toEqual(v2);
  });
});

describe("extractProbeResponses", () => {
  it("extracts numbered responses from standard self-check format", () => {
    const body = `## Drift Self-Assessment

1. **What is my task?**
   I am working on task-001, the monorepo scaffold.

2. **Did I read research docs?**
   Yes, I read the implementation plan before starting.

3. **Have I made changes outside my root?**
   No, all files are within the project directory.
`;
    const responses = extractProbeResponses(body);
    expect(responses).toHaveLength(3);
    expect(responses[0]).toContain("I am working on task-001");
    expect(responses[1]).toContain("Yes, I read the implementation plan");
    expect(responses[2]).toContain("No, all files are within");
  });

  it("handles missing trailing newline", () => {
    const body = `1. **Question one?**
   Answer one.

2. **Question two?**
   Answer two.`;
    const responses = extractProbeResponses(body);
    expect(responses).toHaveLength(2);
    expect(responses[0]).toContain("Answer one");
    expect(responses[1]).toContain("Answer two");
  });

  it("returns empty array for empty body", () => {
    expect(extractProbeResponses("")).toEqual([]);
  });

  it("returns empty array for body with no numbered questions", () => {
    expect(extractProbeResponses("Just some plain text\nwith no questions.")).toEqual([]);
  });

  it("handles multi-line answers spanning multiple paragraphs", () => {
    const body = `1. **Did I submit approvals?**
   I made two design decisions without formal approval:
   - Using tsc --noEmit instead of tsc -b
   - Defining NotePayload interfaces
   Both are within scope and low-risk.
`;
    const responses = extractProbeResponses(body);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toContain("two design decisions");
    expect(responses[0]).toContain("Both are within scope");
  });
});

describe("extractTaskConstraints", () => {
  it("extracts acceptance criteria and out of scope from standard task format", () => {
    const body = `## Task Description

Build the monorepo scaffold.

## Acceptance Criteria

1. pnpm install succeeds at the repo root
2. All TypeScript strict mode — no any types

## Out of Scope

- No crypto implementation
- No UI beyond a placeholder heading

## Crafter Work

Started implementing...
`;
    const result = extractTaskConstraints("task-001", body);
    expect(result.task_id).toBe("task-001");
    expect(result.acceptance_criteria).toContain("pnpm install succeeds");
    expect(result.acceptance_criteria).toContain("TypeScript strict mode");
    expect(result.out_of_scope).toContain("No crypto implementation");
    expect(result.out_of_scope).toContain("No UI beyond a placeholder");
    expect(result.constraints_text).toContain("pnpm install");
    expect(result.constraints_text).toContain("No crypto");
  });

  it("returns empty strings when sections are missing", () => {
    const body = `## Task Description

A task with no criteria sections.

## Crafter Work

Working on it.
`;
    const result = extractTaskConstraints("task-099", body);
    expect(result.acceptance_criteria).toBe("");
    expect(result.out_of_scope).toBe("");
    expect(result.constraints_text).toBe("");
  });

  it("handles task with only acceptance criteria, no out of scope", () => {
    const body = `## Acceptance Criteria

1. Tests pass
2. No regressions

## Crafter Work

Done.
`;
    const result = extractTaskConstraints("task-050", body);
    expect(result.acceptance_criteria).toContain("Tests pass");
    expect(result.out_of_scope).toBe("");
  });
});

describe("constraint retention scoring", () => {
  it("returns high similarity when agent accurately restates constraints", async () => {
    const truthText = "pnpm install succeeds at the repo root with no errors. All TypeScript strict mode, no any types.";
    const agentRestatement = "The acceptance criteria require pnpm install to succeed at the root and TypeScript strict mode with no any types.";

    const truthVector = await embedResponses([truthText]);
    const agentVector = await embedResponses([agentRestatement]);
    const similarity = cosineSimilarity(truthVector, agentVector);
    const score = similarityToDriftScore(similarity);

    // Similar vocabulary should produce low drift score
    expect(score).toBeLessThan(0.4);
  });

  it("returns low similarity when agent restates unrelated content", async () => {
    const truthText = "pnpm install succeeds at the repo root with no errors. All TypeScript strict mode, no any types.";
    const agentRestatement = "I am a research agent focused on investigating database migration patterns and query optimization strategies.";

    const truthVector = await embedResponses([truthText]);
    const agentVector = await embedResponses([agentRestatement]);
    const similarity = cosineSimilarity(truthVector, agentVector);
    const score = similarityToDriftScore(similarity);

    // Unrelated content should produce higher drift score than accurate restatement
    expect(score).toBeGreaterThan(0.3);
  });
});
