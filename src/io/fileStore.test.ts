import { describe, it, expect } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./fileStore.js";

describe("parseFrontmatter", () => {
  it("parses valid YAML frontmatter and body", () => {
    const raw = `---\ntitle: Hello\nstatus: pending\n---\n\nBody content here.`;
    const result = parseFrontmatter<{ title: string; status: string }>(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe("Hello");
    expect(result!.frontmatter.status).toBe("pending");
    expect(result!.body).toBe("Body content here.");
  });

  it("returns null when opening --- is missing", () => {
    const raw = `title: Hello\n---\n\nBody`;
    expect(parseFrontmatter(raw)).toBeNull();
  });

  it("returns null when closing --- is missing", () => {
    const raw = `---\ntitle: Hello\n\nBody without closing`;
    expect(parseFrontmatter(raw)).toBeNull();
  });

  it("returns null when YAML parses to a non-object (scalar)", () => {
    const raw = `---\njust a string\n---\n\nBody`;
    expect(parseFrontmatter(raw)).toBeNull();
  });

  it("returns null when YAML parses to an array", () => {
    const raw = `---\n- one\n- two\n---\n\nBody`;
    expect(parseFrontmatter(raw)).toBeNull();
  });

  it("returns empty body when nothing follows closing ---", () => {
    const raw = `---\nkey: value\n---\n`;
    const result = parseFrontmatter<{ key: string }>(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.key).toBe("value");
    expect(result!.body).toBe("");
  });

  it("handles complex YAML types (arrays, nested objects, null)", () => {
    const raw = `---\nblocked_by:\n  - task-1\n  - task-2\nassigned: null\n---\n\nBody`;
    const result = parseFrontmatter<{ blocked_by: string[]; assigned: null }>(raw);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.blocked_by).toEqual(["task-1", "task-2"]);
    expect(result!.frontmatter.assigned).toBeNull();
  });
});

describe("serializeFrontmatter", () => {
  it("produces valid markdown with --- delimiters", () => {
    const output = serializeFrontmatter({ title: "Hello" }, "Body");
    expect(output).toMatch(/^---\n/);
    expect(output).toContain("title: Hello");
    expect(output).toContain("---\n\nBody");
  });
});

describe("parseFrontmatter ↔ serializeFrontmatter roundtrip", () => {
  it("roundtrips a typical task frontmatter", () => {
    const fm = {
      id: "task-001",
      status: "pending",
      blocked_by: ["task-000"],
      assigned_crafter: null,
      priority: "high",
    };
    const body = "## Crafter Work\n\nSome content here.";
    const serialized = serializeFrontmatter(fm, body);
    const parsed = parseFrontmatter<typeof fm>(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.id).toBe("task-001");
    expect(parsed!.frontmatter.blocked_by).toEqual(["task-000"]);
    expect(parsed!.frontmatter.assigned_crafter).toBeNull();
    expect(parsed!.body).toBe(body);
  });

  it("handles body containing --- without confusion", () => {
    const fm = { key: "value" };
    const body = "Some text\n---\nMore text after a horizontal rule";
    const serialized = serializeFrontmatter(fm, body);
    const parsed = parseFrontmatter<typeof fm>(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.key).toBe("value");
    expect(parsed!.body).toBe(body);
  });
});
