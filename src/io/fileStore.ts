import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import yaml from "js-yaml";

/**
 * Read a file's contents as a string.
 * Returns null if the file does not exist (ENOENT).
 */
export async function readFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Atomically write content to a file.
 * Writes to a sibling temp file, then renames into place —
 * guaranteeing the target is never partially written on crash.
 * Creates parent directories if they do not exist.
 */
export async function writeFile(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err: unknown) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Append a single line to a file (for JSONL event logs).
 * Creates parent directories and the file if they do not exist.
 */
export async function appendLine(
  filePath: string,
  line: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(filePath, line + "\n", "utf-8");
}

/**
 * Parse YAML frontmatter from a markdown document.
 * Returns { frontmatter, body } where frontmatter is the parsed object
 * and body is the markdown content after the closing --- delimiter.
 * Returns null if the file does not have valid frontmatter delimiters.
 */
export function parseFrontmatter<T extends object>(
  raw: string,
): { frontmatter: T; body: string } | null {
  if (!raw.startsWith("---")) {
    return null;
  }

  const closeIndex = raw.indexOf("\n---", 3);
  if (closeIndex === -1) {
    return null;
  }

  const yamlBlock = raw.slice(3, closeIndex).trim();
  const body = raw.slice(closeIndex + 4).trimStart();

  const parsed = yaml.load(yamlBlock);
  if (!isRecord(parsed)) {
    return null;
  }

  return { frontmatter: parsed as T, body };
}

/**
 * Serialize frontmatter back into a markdown document.
 * The body is appended after the closing --- delimiter.
 */
export function serializeFrontmatter(
  frontmatter: object,
  body: string,
): string {
  const yamlBlock = yaml.dump(frontmatter, { lineWidth: 120, noRefs: true });
  return `---\n${yamlBlock}---\n\n${body}`;
}

/**
 * Read a markdown file and parse its YAML frontmatter.
 * Returns null if the file does not exist or has no frontmatter.
 */
export async function readMarkdownFile<T extends object>(
  filePath: string,
): Promise<{ frontmatter: T; body: string; rawContent: string } | null> {
  const raw = await readFile(filePath);
  if (raw === null) {
    return null;
  }

  const parsed = parseFrontmatter<T>(raw);
  if (parsed === null) {
    return null;
  }

  return { ...parsed, rawContent: raw };
}

/**
 * Atomically write a markdown file with YAML frontmatter.
 */
export async function writeMarkdownFile(
  filePath: string,
  frontmatter: object,
  body: string,
): Promise<void> {
  const content = serializeFrontmatter(frontmatter, body);
  await writeFile(filePath, content);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
