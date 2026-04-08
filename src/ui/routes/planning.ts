/**
 * Planning routes — file upload endpoint for the project submission chat.
 *
 * POST /api/planning/upload  — Upload a document, parse to text, store in session
 */
import { Router } from "express";
import multer from "multer";
import { parseDocument, resolveMimeType, isSupportedExtension } from "../../services/documentParser.js";
import { getSession, addDocument } from "../../services/planningAgent.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

export function createPlanningRoutes(): Router {
  const router = Router();

  // POST /api/planning/upload
  router.post("/upload", upload.single("file"), async (req, res) => {
    const file = req.file;
    if (file === undefined) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const sessionId = req.body?.sessionId as string | undefined;
    if (sessionId === undefined || sessionId === "") {
      res.status(400).json({ error: "Missing sessionId" });
      return;
    }

    const session = getSession(sessionId);
    if (session === undefined) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (!isSupportedExtension(file.originalname)) {
      res.status(400).json({ error: `Unsupported file type. Accepted: .md, .txt, .pdf, .docx` });
      return;
    }

    try {
      const mimeType = resolveMimeType(file.originalname, file.mimetype);
      const content = await parseDocument(file.buffer, mimeType);

      addDocument(sessionId, { name: file.originalname, content });

      res.json({
        name: file.originalname,
        preview: content.slice(0, 500) + (content.length > 500 ? "..." : ""),
        length: content.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: `Failed to parse document: ${msg}` });
    }
  });

  return router;
}
