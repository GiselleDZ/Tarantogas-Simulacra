import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateGitignoreContent, mergeGitignoreContent } from "./gitignoreGenerator.js";

// ── Pure function tests ─────────────────────────────────────────────────────

describe("generateGitignoreContent", () => {
  it("detects Node.js from package.json", () => {
    const result = generateGitignoreContent(["package.json", "src"]);
    expect(result.detectedStacks).toContain("node");
    expect(result.content).toContain("node_modules/");
  });

  it("detects Rust from Cargo.toml", () => {
    const result = generateGitignoreContent(["Cargo.toml", "src"]);
    expect(result.detectedStacks).toContain("rust");
    expect(result.content).toContain("target/");
  });

  it("detects Python from pyproject.toml", () => {
    const result = generateGitignoreContent(["pyproject.toml"]);
    expect(result.detectedStacks).toContain("python");
    expect(result.content).toContain("__pycache__/");
  });

  it("detects multiple stacks simultaneously", () => {
    const result = generateGitignoreContent(["package.json", "Cargo.toml", "pyproject.toml"]);
    expect(result.detectedStacks).toContain("node");
    expect(result.detectedStacks).toContain("rust");
    expect(result.detectedStacks).toContain("python");
    expect(result.content).toContain("node_modules/");
    expect(result.content).toContain("target/");
    expect(result.content).toContain("__pycache__/");
  });

  it("returns universal entries only when no markers found", () => {
    const result = generateGitignoreContent(["README.md", "LICENSE"]);
    expect(result.detectedStacks).toEqual([]);
    expect(result.content).toContain(".DS_Store");
    expect(result.content).toContain(".env");
    expect(result.content).not.toContain("node_modules/");
  });

  it("always includes universal entries alongside stack-specific ones", () => {
    const result = generateGitignoreContent(["Cargo.toml"]);
    expect(result.content).toContain(".DS_Store");
    expect(result.content).toContain(".env");
    expect(result.content).toContain("target/");
  });

  it("deduplicates patterns when stacks overlap", () => {
    // Both Node and TypeScript can produce dist/
    const result = generateGitignoreContent(["package.json", "tsconfig.json"]);
    const lines = result.content.split("\n");
    const distLines = lines.filter((l) => l.trim() === "dist/");
    expect(distLines.length).toBe(1);
  });

  it("detects Node.js from alternative markers like yarn.lock", () => {
    const result = generateGitignoreContent(["yarn.lock", "src"]);
    expect(result.detectedStacks).toContain("node");
    expect(result.content).toContain("node_modules/");
  });

  it("detects Node.js from pnpm-lock.yaml", () => {
    const result = generateGitignoreContent(["pnpm-lock.yaml"]);
    expect(result.detectedStacks).toContain("node");
  });

  it("detects Python from setup.py", () => {
    const result = generateGitignoreContent(["setup.py"]);
    expect(result.detectedStacks).toContain("python");
  });

  it("detects Python from Pipfile", () => {
    const result = generateGitignoreContent(["Pipfile"]);
    expect(result.detectedStacks).toContain("python");
  });

  it("detects Go from go.mod", () => {
    const result = generateGitignoreContent(["go.mod"]);
    expect(result.detectedStacks).toContain("go");
  });

  it("detects Ruby from Gemfile", () => {
    const result = generateGitignoreContent(["Gemfile"]);
    expect(result.detectedStacks).toContain("ruby");
    expect(result.content).toContain("vendor/bundle/");
  });

  it("detects JVM from pom.xml", () => {
    const result = generateGitignoreContent(["pom.xml"]);
    expect(result.detectedStacks).toContain("jvm");
    expect(result.content).toContain("*.class");
  });

  it("detects JVM from build.gradle", () => {
    const result = generateGitignoreContent(["build.gradle"]);
    expect(result.detectedStacks).toContain("jvm");
  });
});

describe("mergeGitignoreContent", () => {
  it("appends only missing entries", () => {
    const existing = "node_modules/\n.DS_Store\n";
    const generated = generateGitignoreContent(["package.json"]);
    const result = mergeGitignoreContent(existing, generated);
    expect(result).not.toBeNull();
    // Should not duplicate node_modules/ or .DS_Store
    expect(result!.split("node_modules/").length - 1).toBe(1);
    expect(result!.split(".DS_Store").length - 1).toBe(1);
    // Should still contain the new patterns
    expect(result).toContain(".npm");
  });

  it("returns null when all entries already present", () => {
    const generated = generateGitignoreContent(["README.md"]); // universal only
    // Build existing that contains all universal patterns
    const result = mergeGitignoreContent(generated.content, generated);
    expect(result).toBeNull();
  });

  it("preserves existing content verbatim", () => {
    const existing = "# My custom rules\nfoo/\nbar/\n";
    const generated = generateGitignoreContent(["package.json"]);
    const result = mergeGitignoreContent(existing, generated);
    expect(result).not.toBeNull();
    expect(result!.startsWith(existing)).toBe(true);
  });

  it("handles empty existing content", () => {
    const generated = generateGitignoreContent(["package.json"]);
    const result = mergeGitignoreContent("", generated);
    expect(result).not.toBeNull();
    expect(result).toContain("node_modules/");
    expect(result).toContain("# ── Simulacra (auto-generated)");
  });

  it("adds Simulacra section header when appending", () => {
    const existing = "foo/\n";
    const generated = generateGitignoreContent(["Cargo.toml"]);
    const result = mergeGitignoreContent(existing, generated);
    expect(result).not.toBeNull();
    expect(result).toContain("# ── Simulacra (auto-generated)");
  });
});

// ── IO boundary tests ───────────────────────────────────────────────────────

const mockReaddir = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  promises: {
    readdir: mockReaddir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
  },
}));

import { ensureGitignore } from "./gitignoreGenerator.js";

describe("ensureGitignore", () => {
  beforeEach(() => {
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
  });

  it("creates .gitignore when none exists", async () => {
    mockReaddir.mockResolvedValue(["package.json", "src"]);
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await ensureGitignore("/projects/cool");

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [writePath, content] = mockWriteFile.mock.calls[0] as [string, string];
    expect(writePath).toContain(".gitignore");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".DS_Store");
  });

  it("merges into existing .gitignore", async () => {
    mockReaddir.mockResolvedValue(["package.json", "Cargo.toml"]);
    mockReadFile.mockResolvedValue("# Existing\nnode_modules/\n");

    await ensureGitignore("/projects/cool");

    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const content = mockWriteFile.mock.calls[0]![1] as string;
    expect(content).toContain("# Existing\nnode_modules/\n");
    expect(content).toContain("target/");
    expect(content).toContain("# ── Simulacra (auto-generated)");
  });

  it("does not write when no new entries needed", async () => {
    const generated = generateGitignoreContent(["README.md"]);
    mockReaddir.mockResolvedValue(["README.md"]);
    mockReadFile.mockResolvedValue(generated.content);

    await ensureGitignore("/projects/cool");

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("handles readdir failure gracefully without throwing", async () => {
    mockReaddir.mockRejectedValue(new Error("EACCES"));

    // Should not throw
    await expect(ensureGitignore("/projects/cool")).resolves.toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
