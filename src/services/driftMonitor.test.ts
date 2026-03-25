import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  similarityToDriftScore,
  scoreToDriftSeverity,
  severityToAction,
  embedResponses,
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
