import { describe, it, expect } from "vitest";
import { parseAgentLogLines } from "./agentLog.js";

describe("parseAgentLogLines", () => {
  it("extracts a PHASE line", () => {
    const content = "## Crafter Work\n\nPHASE: implementation\n";
    const lines = parseAgentLogLines(content);
    expect(lines.length).toBe(1);
    expect(lines[0]!.type).toBe("PHASE");
    expect(lines[0]!.message).toBe("implementation");
    expect(lines[0]!.section).toBe("Crafter Work");
  });

  it("extracts a DECISION line", () => {
    const content = "## Council Review\n\nDECISION: approved with minor feedback\n";
    const lines = parseAgentLogLines(content);
    expect(lines.length).toBe(1);
    expect(lines[0]!.type).toBe("DECISION");
    expect(lines[0]!.message).toBe("approved with minor feedback");
  });

  it("tracks section headers correctly across multiple sections", () => {
    const content = [
      "## Crafter Work",
      "",
      "PHASE: starting",
      "",
      "## Steward Review",
      "",
      "DECISION: revision needed",
      "",
    ].join("\n");
    const lines = parseAgentLogLines(content);
    expect(lines.length).toBe(2);
    expect(lines[0]!.section).toBe("Crafter Work");
    expect(lines[1]!.section).toBe("Steward Review");
  });

  it("handles interleaved PHASE and DECISION lines", () => {
    const content = [
      "## Crafter Work",
      "PHASE: analysis",
      "DECISION: proceeding with approach A",
      "PHASE: implementation",
    ].join("\n");
    const lines = parseAgentLogLines(content);
    expect(lines.length).toBe(3);
    expect(lines[0]!.type).toBe("PHASE");
    expect(lines[1]!.type).toBe("DECISION");
    expect(lines[2]!.type).toBe("PHASE");
  });

  it("returns empty array for content with no log lines", () => {
    const content = "## Crafter Work\n\nJust regular text, no PHASE or DECISION.";
    const lines = parseAgentLogLines(content);
    expect(lines.length).toBe(0);
  });

  it("returns empty array for empty content", () => {
    expect(parseAgentLogLines("").length).toBe(0);
  });
});
