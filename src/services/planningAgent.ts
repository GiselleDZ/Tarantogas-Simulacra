/**
 * Planning agent — conversational agent for project submission.
 *
 * Uses Claude Code subprocesses (runs on the user's Claude Code subscription)
 * instead of direct Anthropic API calls. Each message spawns a `claude --print`
 * process; multi-turn conversation is maintained via `--resume {session_id}`.
 *
 * Sessions are in-memory and expire after a configurable timeout.
 */
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { promises as fs } from "fs";
import { onboardProject } from "../workflow/onboarding.js";
import { readFile } from "../io/fileStore.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface UploadedDocument {
  readonly name: string;
  readonly content: string;
}

export interface PlanningSession {
  readonly id: string;
  readonly uploadedDocuments: UploadedDocument[];
  readonly createdAt: string;
  lastActivityAt: string;
  projectCreated: boolean;
  projectSlug?: string;
  /** Claude Code session ID for --resume. Null until first response. */
  claudeSessionId: string | null;
}

export interface StreamCallbacks {
  onText: (delta: string) => void;
  onDone: () => void;
  onProjectCreated: (slug: string, approvalId: string) => void;
  onError: (error: string) => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "sonnet";
const MAX_SESSION_AGE_MS = 3_600_000; // 1 hour
const CLEANUP_INTERVAL_MS = 300_000;  // 5 minutes

const SYSTEM_PROMPT = `You are a project planning assistant for Simulacra, a multi-agent orchestration system. Your job is to help the user define a new software project so it can be onboarded into the system.

## Your Responsibilities

1. **Understand the project.** Read any documents the user provides. Ask clarifying questions about scope, goals, and technical requirements.

2. **Identify crafter types needed.** Simulacra has specialized crafter agents:
   - frontend — React, Vue, HTML/CSS, UI work
   - backend — Node.js, Python, APIs, databases, server logic
   - devops — Infrastructure, CI/CD, deployment, Docker
   - data — Data pipelines, schemas, analysis, ML

3. **Clarify the project name.** Help the user settle on a clear, concise project name.

4. **When the user is ready** — they'll say something like "create it", "let's go", "submit", etc. — output the following sentinel on its own line with the project details as JSON:

PROJECT_READY: {"name":"Project Name","crafterTypes":["frontend","backend"],"planSummary":"# Implementation Plan\\n\\n...full markdown plan..."}

The planSummary should be a complete implementation plan that a Council agent can use to create tasks. Structure it with phases, deliverables, and technical requirements.

## Guidelines

- Be concise and direct. Ask one or two questions at a time, not a wall of questions.
- If the user provides a detailed plan document, don't re-ask everything in it. Focus on gaps.
- If the user hasn't provided enough information to create a useful plan, tell them what's missing before outputting the sentinel.
- Do NOT use any tools. Just have a conversation and output the PROJECT_READY sentinel when ready.`;

// ── Session Management ───────────────────────────────────────────────────────

const sessions = new Map<string, PlanningSession>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function createSession(): PlanningSession {
  const session: PlanningSession = {
    id: randomUUID(),
    uploadedDocuments: [],
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    projectCreated: false,
    claudeSessionId: null,
  };
  sessions.set(session.id, session);
  ensureCleanupTimer();
  return session;
}

export function getSession(id: string): PlanningSession | undefined {
  return sessions.get(id);
}

export function addDocument(sessionId: string, doc: UploadedDocument): void {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`Session not found: ${sessionId}`);
  session.uploadedDocuments.push(doc);
  session.lastActivityAt = new Date().toISOString();
}

function destroySession(id: string): void {
  sessions.delete(id);
  if (sessions.size === 0 && cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function ensureCleanupTimer(): void {
  if (cleanupTimer !== null) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - new Date(session.lastActivityAt).getTime() > MAX_SESSION_AGE_MS) {
        console.log(`[PlanningAgent] Session ${id} expired — cleaning up`);
        destroySession(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}

// ── Message Handling ─────────────────────────────────────────────────────────

/**
 * Send a user message via a Claude Code subprocess.
 * First message uses --system-prompt; subsequent messages use --resume.
 */
export async function sendMessage(
  sessionId: string,
  userText: string,
  callbacks: StreamCallbacks,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    callbacks.onError("Session not found");
    return;
  }

  session.lastActivityAt = new Date().toISOString();

  // Prepend uploaded documents to the message
  let fullMessage = "";
  for (const doc of session.uploadedDocuments) {
    fullMessage += `[Uploaded document: ${doc.name}]\n\n${doc.content}\n\n---\n\n`;
  }
  session.uploadedDocuments.length = 0;
  fullMessage += userText;

  try {
    const result = await runClaudeCodeTurn(session, fullMessage, callbacks);

    // Check for PROJECT_READY sentinel in the response
    const sentinelMatch = result.match(/PROJECT_READY:\s*(\{[\s\S]*\})/);
    if (sentinelMatch !== null) {
      try {
        const projectData = JSON.parse(sentinelMatch[1]!) as {
          name: string;
          crafterTypes: string[];
          planSummary: string;
        };
        const createResult = await executeCreateProject(projectData);
        if (createResult.success && createResult.slug !== undefined && createResult.approvalId !== undefined) {
          session.projectCreated = true;
          session.projectSlug = createResult.slug;
          callbacks.onProjectCreated(createResult.slug, createResult.approvalId);
        }
      } catch (parseErr: unknown) {
        console.error("[PlanningAgent] Failed to parse PROJECT_READY sentinel:", parseErr);
      }
    }

    callbacks.onDone();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PlanningAgent] Error in session ${sessionId}:`, msg);
    callbacks.onError(msg);
  }
}

/**
 * Spawn a `claude --print` process for a single conversational turn.
 * Uses --resume for multi-turn continuity.
 */
function runClaudeCodeTurn(
  session: PlanningSession,
  prompt: string,
  callbacks: StreamCallbacks,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--model", DEFAULT_MODEL,
      "--tools", "",  // disable all tools — planning agent is conversation-only
    ];

    // First turn: inject system prompt. Subsequent turns: resume session.
    if (session.claudeSessionId === null) {
      args.push("--system-prompt", SYSTEM_PROMPT);
    } else {
      args.push("--resume", session.claudeSessionId);
    }

    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    // Deliver prompt via stdin
    proc.stdin!.write(prompt, "utf-8");
    proc.stdin!.end();

    let fullText = "";
    let lastTextSent = "";

    proc.stdout!.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf-8").split("\n").filter(l => l.trim().length > 0);

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as {
            type: string;
            session_id?: string;
            result?: string;
            message?: {
              content?: Array<{ type: string; text?: string }>;
            };
          };

          // Capture session ID from any event that has one
          if (event.session_id !== undefined) {
            session.claudeSessionId = event.session_id;
          }

          // Extract text from assistant messages
          if (event.type === "assistant" && event.message?.content !== undefined) {
            for (const block of event.message.content) {
              if (block.type === "text" && block.text !== undefined) {
                // The text field contains the full text so far, not a delta.
                // Compute the delta from what we've already sent.
                if (block.text.length > lastTextSent.length) {
                  const delta = block.text.slice(lastTextSent.length);
                  callbacks.onText(delta);
                  lastTextSent = block.text;
                  fullText = block.text;
                }
              }
            }
          }

          // Final result
          if (event.type === "result" && event.result !== undefined) {
            fullText = event.result;
          }
        } catch {
          // Non-JSON line, ignore
        }
      }
    });

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text.length > 0) {
        console.error(`[PlanningAgent] stderr: ${text}`);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to start claude process: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`claude process exited with code ${code}`));
      } else {
        resolve(fullText);
      }
    });
  });
}

// ── Project Creation ─────────────────────────────────────────────────────────

interface CreateProjectResult {
  success: boolean;
  slug?: string;
  approvalId?: string;
  error?: string;
}

async function executeCreateProject(args: {
  name: string;
  crafterTypes: string[];
  planSummary: string;
}): Promise<CreateProjectResult> {
  try {
    // Auto-create project directory as sibling of Simulacra
    const simulacraParent = path.dirname(process.cwd());
    const slug = args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const projectPath = path.join(simulacraParent, slug);

    // Create project directory and write implementation plan
    await fs.mkdir(path.join(projectPath, "docs"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, "docs", "implementation-plan.md"),
      args.planSummary,
      "utf-8",
    );

    console.log(`[PlanningAgent] Created project directory at ${projectPath}`);

    // Onboard through normal flow
    const result = await onboardProject({
      name: args.name,
      path: projectPath,
      crafterTypes: args.crafterTypes,
      requestedBy: "tarantoga",
    });

    console.log(`[PlanningAgent] Project onboarded: ${result.slug} (approval: ${result.approvalId})`);

    return { success: true, slug: result.slug, approvalId: result.approvalId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PlanningAgent] Failed to create project:`, msg);
    return { success: false, error: msg };
  }
}
