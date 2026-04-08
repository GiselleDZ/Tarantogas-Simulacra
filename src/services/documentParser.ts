/**
 * Document parser — converts uploaded files (.md, .txt, .pdf, .docx) to plain text.
 *
 * Used by the planning agent to ingest implementation plans and roadmaps
 * submitted through the project submission chat interface.
 */

const SUPPORTED_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const EXTENSION_MIME_MAP: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * Resolve MIME type from file extension when the upload middleware
 * reports a generic or missing type.
 */
export function resolveMimeType(originalname: string, reportedMime: string): string {
  if (SUPPORTED_MIME_TYPES.has(reportedMime)) return reportedMime;

  const ext = originalname.slice(originalname.lastIndexOf(".")).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? reportedMime;
}

/**
 * Parse an uploaded document buffer into plain text.
 * Throws on unsupported types or parse failures.
 */
export async function parseDocument(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  switch (mimeType) {
    case "text/plain":
    case "text/markdown":
      return buffer.toString("utf-8");

    case "application/pdf":
      return parsePdf(buffer);

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return parseDocx(buffer);

    default:
      throw new Error(`Unsupported document type: ${mimeType}`);
  }
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const { pdf } = await import("pdf-parse");
  const result = await pdf(buffer);
  return result.text;
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/**
 * Check whether a file extension is supported for upload.
 */
export function isSupportedExtension(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return ext in EXTENSION_MIME_MAP;
}
