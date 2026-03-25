/**
 * MCP egress proxy.
 *
 * A lightweight HTTP/HTTPS proxy that gates outbound MCP server network calls
 * to an explicit domain allowlist. Pure Node.js — no OS-level features, works
 * on macOS, Linux, and Windows.
 *
 * MCP servers are configured to route traffic through this proxy by injecting
 * HTTP_PROXY / HTTPS_PROXY into their environment variables (see spawner.ts).
 *
 * Allowlist format:
 *   - Exact hostname:  "api.search.brave.com"
 *   - Wildcard prefix: "*.upstash.io"  (matches subdomains only, NOT the apex)
 */
import crypto from "crypto";
import dns from "node:dns/promises";
import http from "http";
import net from "net";
import { URL } from "url";

export interface McpProxyOptions {
  readonly port: number;
  readonly allowlist: readonly string[];
}

/** Ports allowed through CONNECT tunnelling. */
const ALLOWED_PORTS = new Set([80, 443]);

/** Hop-by-hop headers that must not be forwarded upstream. */
const HOP_BY_HOP_HEADERS: readonly string[] = [
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "upgrade",
];

/**
 * Check hostname against the allowlist.
 * Wildcard entries like "*.upstash.io" match subdomains only — the apex
 * domain "upstash.io" is NOT matched. Add it explicitly if needed.
 */
export function isAllowed(hostname: string, allowlist: readonly string[]): boolean {
  for (const pattern of allowlist) {
    if (pattern.startsWith("*.")) {
      if (hostname.endsWith(pattern.slice(1))) return true;
    } else if (hostname === pattern) {
      return true;
    }
  }
  return false;
}

/** Returns true if the IP is in a private, loopback, or link-local range. */
export function isPrivateIp(ip: string): boolean {
  // IPv4
  if (ip === "0.0.0.0") return true;
  if (ip.startsWith("127.")) return true;       // 127.0.0.0/8
  if (ip.startsWith("10.")) return true;         // 10.0.0.0/8
  if (ip.startsWith("192.168.")) return true;    // 192.168.0.0/16
  if (ip.startsWith("169.254.")) return true;    // 169.254.0.0/16
  if (ip.startsWith("172.")) {                   // 172.16.0.0/12
    const second = parseInt(ip.split(".")[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv6
  if (ip === "::1") return true;
  const lower = ip.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;  // fc00::/7
  if (lower.startsWith("fe80")) return true;                           // fe80::/10

  return false;
}

/**
 * Resolve hostname via DNS and reject private/loopback IPs.
 * Prevents DNS rebinding attacks where an allowlisted hostname resolves
 * to an internal IP at connect time.
 */
async function resolveAndValidate(hostname: string): Promise<string> {
  const { address } = await dns.lookup(hostname);
  if (isPrivateIp(address)) {
    throw new Error(`DNS rebinding blocked: ${hostname} resolved to private IP ${address}`);
  }
  return address;
}

/** Clone headers and strip hop-by-hop entries that should not be forwarded. */
function sanitizeHeaders(raw: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...raw };
  for (const h of HOP_BY_HOP_HEADERS) {
    delete headers[h];
  }
  return headers;
}

export class McpProxyServer {
  private readonly server: http.Server;
  private readonly _token: string;

  /** Auth token that must be presented as `Bearer <token>` in Proxy-Authorization. */
  get token(): string {
    return this._token;
  }

  constructor(private readonly options: McpProxyOptions) {
    this._token = crypto.randomUUID();
    this.server = http.createServer();

    // ── Plain HTTP requests ───────────────────────────────────────────────────
    // HTTP proxying uses absolute-form request targets: GET http://host/path
    this.server.on("request", (req, res) => {
      if (req.headers["proxy-authorization"] !== `Bearer ${this._token}`) {
        res.writeHead(407);
        res.end("Proxy Authentication Required");
        return;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(req.url ?? "");
      } catch {
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }

      if (!isAllowed(parsedUrl.hostname, options.allowlist)) {
        console.warn(`[McpProxy] BLOCKED  ${parsedUrl.hostname}  (not in allowlist)`);
        res.writeHead(403);
        res.end(`Forbidden: ${parsedUrl.hostname} is not in the Simulacra MCP proxy allowlist`);
        return;
      }

      const originalHostname = parsedUrl.hostname;

      void resolveAndValidate(originalHostname).then((resolvedIp) => {
        const resolvedUrl = new URL(parsedUrl.toString());
        resolvedUrl.hostname = resolvedIp;

        const headers = sanitizeHeaders(req.headers);
        headers["host"] = originalHostname;

        const proxyReq = http.request(
          resolvedUrl.toString(),
          { method: req.method, headers },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res, { end: true });
          },
        );
        proxyReq.on("error", () => { res.writeHead(502); res.end(); });
        req.pipe(proxyReq, { end: true });
      }).catch((err: unknown) => {
        console.warn(`[McpProxy] BLOCKED  ${originalHostname}  (${String(err)})`);
        res.writeHead(403);
        res.end(`Forbidden: ${String(err)}`);
      });
    });

    // ── HTTPS CONNECT tunnelling ──────────────────────────────────────────────
    // HTTPS clients send: CONNECT hostname:443 HTTP/1.1
    // The proxy opens a raw TCP tunnel to the target after allowlist check.
    this.server.on("connect", (req, clientSocket, head) => {
      if (req.headers["proxy-authorization"] !== `Bearer ${this._token}`) {
        clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      const target = req.url ?? "";
      const lastColon = target.lastIndexOf(":");
      const host = lastColon === -1 ? target : target.slice(0, lastColon);
      const port = lastColon === -1 ? 443 : (parseInt(target.slice(lastColon + 1), 10) || 443);

      if (!ALLOWED_PORTS.has(port)) {
        console.warn(`[McpProxy] BLOCKED  ${host}:${port}  (port not allowed)`);
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      if (!isAllowed(host, options.allowlist)) {
        console.warn(`[McpProxy] BLOCKED  ${host}  (not in allowlist)`);
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }

      void resolveAndValidate(host).then((resolvedIp) => {
        const serverSocket = net.connect(port, resolvedIp, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) serverSocket.write(head);
          serverSocket.pipe(clientSocket, { end: true });
          clientSocket.pipe(serverSocket, { end: true });
        });

        serverSocket.on("error", () => {
          if (!clientSocket.destroyed) {
            clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            clientSocket.destroy();
          }
        });
        clientSocket.on("error", () => { serverSocket.destroy(); });
      }).catch((err: unknown) => {
        console.warn(`[McpProxy] BLOCKED  ${host}  (${String(err)})`);
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    console.log(
      `[McpProxy] Running on localhost:${this.options.port} — allowlist: ${this.options.allowlist.join(", ") || "(empty — all external traffic blocked)"}`,
    );
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err !== undefined ? reject(err) : resolve()));
    });
  }
}
