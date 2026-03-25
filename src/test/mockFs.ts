/**
 * Virtual in-memory filesystem for testing.
 *
 * Replaces fileStore's exports so tests never touch the real disk.
 * Uses real parseFrontmatter/serializeFrontmatter for roundtrip fidelity.
 */
import { parseFrontmatter, serializeFrontmatter } from "../io/fileStore.js";

export interface MockFs {
  /** The underlying file map. */
  readonly files: Map<string, string>;
  /** Seed a file into the virtual fs before the test runs. */
  seedFile(path: string, content: string): void;
  /** Read a file from the virtual fs (returns null if absent). */
  getFile(path: string): string | null;
  /** Mock implementations to install via vi.mocked(). */
  readonly mockReadFile: (filePath: string) => Promise<string | null>;
  readonly mockWriteFile: (filePath: string, content: string) => Promise<void>;
  readonly mockAppendLine: (filePath: string, line: string) => Promise<void>;
  readonly mockReadMarkdownFile: <T extends object>(
    filePath: string,
  ) => Promise<{ frontmatter: T; body: string; rawContent: string } | null>;
  readonly mockWriteMarkdownFile: (
    filePath: string,
    frontmatter: object,
    body: string,
  ) => Promise<void>;
}

export function createMockFs(): MockFs {
  const files = new Map<string, string>();

  const mockReadFile = async (filePath: string): Promise<string | null> => {
    return files.get(normalize(filePath)) ?? null;
  };

  const mockWriteFile = async (filePath: string, content: string): Promise<void> => {
    files.set(normalize(filePath), content);
  };

  const mockAppendLine = async (filePath: string, line: string): Promise<void> => {
    const key = normalize(filePath);
    const existing = files.get(key) ?? "";
    files.set(key, existing + line + "\n");
  };

  const mockReadMarkdownFile = async <T extends object>(
    filePath: string,
  ): Promise<{ frontmatter: T; body: string; rawContent: string } | null> => {
    const raw = files.get(normalize(filePath));
    if (raw === undefined) return null;
    const parsed = parseFrontmatter<T>(raw);
    if (parsed === null) return null;
    return { ...parsed, rawContent: raw };
  };

  const mockWriteMarkdownFile = async (
    filePath: string,
    frontmatter: object,
    body: string,
  ): Promise<void> => {
    const content = serializeFrontmatter(frontmatter, body);
    files.set(normalize(filePath), content);
  };

  return {
    files,
    seedFile: (path, content) => files.set(normalize(path), content),
    getFile: (path) => files.get(normalize(path)) ?? null,
    mockReadFile,
    mockWriteFile,
    mockAppendLine,
    mockReadMarkdownFile,
    mockWriteMarkdownFile,
  };
}

/** Normalize path separators for consistent map keys. */
function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}
