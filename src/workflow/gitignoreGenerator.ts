import path from "path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitignoreResult {
  readonly detectedStacks: readonly string[];
  readonly content: string;
}

// ── Tech Stack Rules ─────────────────────────────────────────────────────────

interface StackRule {
  readonly stack: string;
  readonly markers: readonly string[];
  readonly patterns: readonly string[];
}

const TECH_STACK_RULES: readonly StackRule[] = [
  {
    stack: "node",
    markers: ["package.json", "yarn.lock", "pnpm-lock.yaml"],
    patterns: ["node_modules/", ".npm"],
  },
  {
    stack: "rust",
    markers: ["Cargo.toml"],
    patterns: ["target/"],
  },
  {
    stack: "python",
    markers: ["pyproject.toml", "setup.py", "Pipfile"],
    patterns: ["__pycache__/", "*.pyc", ".venv/", "dist/", "*.egg-info/"],
  },
  {
    stack: "typescript",
    markers: ["tsconfig.json"],
    patterns: ["dist/", "*.tsbuildinfo"],
  },
  {
    stack: "go",
    markers: ["go.mod"],
    patterns: [],
  },
  {
    stack: "ruby",
    markers: ["Gemfile"],
    patterns: ["vendor/bundle/", ".bundle/"],
  },
  {
    stack: "jvm",
    markers: ["pom.xml", "build.gradle"],
    patterns: ["build/", ".gradle/", "target/", "*.class"],
  },
];

const UNIVERSAL_PATTERNS: readonly string[] = [
  ".DS_Store",
  ".env",
  ".env.*",
  "!.env.example",
  "*.log",
  "coverage/",
  ".idea/",
  ".vscode/settings.json",
];

// ── Pure Functions ───────────────────────────────────────────────────────────

export function generateGitignoreContent(filesInDir: readonly string[]): GitignoreResult {
  const fileSet = new Set(filesInDir);
  const detectedStacks: string[] = [];
  const patterns = new Set<string>(UNIVERSAL_PATTERNS);

  for (const rule of TECH_STACK_RULES) {
    const matched = rule.markers.some((m) => fileSet.has(m));
    if (matched) {
      detectedStacks.push(rule.stack);
      for (const p of rule.patterns) {
        patterns.add(p);
      }
    }
  }

  const content = [...patterns].join("\n") + "\n";
  return { detectedStacks, content };
}

export function mergeGitignoreContent(existing: string, generated: GitignoreResult): string | null {
  const existingLines = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#")),
  );

  const newPatterns = generated.content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .filter((l) => !existingLines.has(l));

  if (newPatterns.length === 0) {
    return null;
  }

  const section = "\n# ── Simulacra (auto-generated)\n" + newPatterns.join("\n") + "\n";
  return existing + section;
}

// ── IO Boundary ──────────────────────────────────────────────────────────────

export async function ensureGitignore(projectPath: string): Promise<void> {
  const { promises: fs } = await import("fs");

  let files: string[];
  try {
    files = await fs.readdir(projectPath);
  } catch {
    console.warn(`[gitignore] Could not read directory: ${projectPath}`);
    return;
  }

  const generated = generateGitignoreContent(files);
  const gitignorePath = path.join(projectPath, ".gitignore");

  let existing: string | null = null;
  try {
    existing = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // No existing .gitignore — that's fine
  }

  if (existing === null) {
    await fs.writeFile(gitignorePath, generated.content, "utf-8");
    return;
  }

  const merged = mergeGitignoreContent(existing, generated);
  if (merged === null) {
    return; // Nothing new to add
  }

  await fs.writeFile(gitignorePath, merged, "utf-8");
}
