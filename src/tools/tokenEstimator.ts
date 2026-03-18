/**
 * TokenEstimator — character-based token count estimation for Council planning.
 *
 * Estimates token counts for a list of files using a character-per-token heuristic.
 * No external dependencies. Accuracy: ±15%, sufficient for the 60k-token ceiling check.
 *
 * Heuristic:
 *   - Code files (.ts, .js, .py, etc.): ~3.5 chars/token (denser BPE encoding)
 *   - Prose files (.md, .yaml, .json, etc.): ~4.0 chars/token
 *
 * Research basis: state/knowledge/global/research/token-estimation.md
 */
import { promises as fs } from "fs";
import path from "path";

// Files above this character count get a "high density" warning
const HIGH_DENSITY_THRESHOLD_CHARS = 100_000;

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
  ".sh", ".bash",
]);

const CHARS_PER_TOKEN_CODE = 3.5;
const CHARS_PER_TOKEN_PROSE = 4.0;

export interface FileTokenEstimate {
  readonly filePath: string;
  readonly characters: number;
  readonly estimatedTokens: number;
  /** True when character count is high enough that the heuristic may underestimate */
  readonly highDensityWarning: boolean;
}

export interface TokenEstimateResult {
  readonly files: readonly FileTokenEstimate[];
  readonly totalCharacters: number;
  readonly totalEstimatedTokens: number;
}

/**
 * Estimate the total token cost of a list of files.
 * Missing files are silently skipped (token count of 0).
 */
export async function estimateTokens(
  filePaths: readonly string[],
): Promise<TokenEstimateResult> {
  const files: FileTokenEstimate[] = [];
  let totalCharacters = 0;
  let totalEstimatedTokens = 0;

  for (const filePath of filePaths) {
    const estimate = await estimateFileTokens(filePath);
    files.push(estimate);
    totalCharacters += estimate.characters;
    totalEstimatedTokens += estimate.estimatedTokens;
  }

  return { files, totalCharacters, totalEstimatedTokens };
}

async function estimateFileTokens(filePath: string): Promise<FileTokenEstimate> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { filePath, characters: 0, estimatedTokens: 0, highDensityWarning: false };
  }

  const characters = content.length;
  const ext = path.extname(filePath).toLowerCase();
  const charsPerToken = CODE_EXTENSIONS.has(ext) ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_PROSE;
  const estimatedTokens = Math.ceil(characters / charsPerToken);
  const highDensityWarning = characters > HIGH_DENSITY_THRESHOLD_CHARS;

  return { filePath, characters, estimatedTokens, highDensityWarning };
}
