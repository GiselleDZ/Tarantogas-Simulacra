import { describe, it, expect, afterAll } from "vitest";
import { isAllowed, isPrivateIp, McpProxyServer } from "./mcpProxy.js";
import http from "http";
import net from "net";

describe("isAllowed", () => {
  const allowlist = ["api.brave.com", "*.upstash.io", "example.com"];

  it("matches exact hostname", () => {
    expect(isAllowed("api.brave.com", allowlist)).toBe(true);
  });

  it("rejects non-matching hostname", () => {
    expect(isAllowed("evil.com", allowlist)).toBe(false);
  });

  it("matches wildcard subdomain", () => {
    expect(isAllowed("redis.upstash.io", allowlist)).toBe(true);
  });

  it("matches deep wildcard subdomain", () => {
    expect(isAllowed("a.b.upstash.io", allowlist)).toBe(true);
  });

  it("does NOT match apex domain for wildcard (fix 1g)", () => {
    expect(isAllowed("upstash.io", allowlist)).toBe(false);
  });

  it("does NOT match suffix-only (no dot boundary)", () => {
    expect(isAllowed("evil-upstash.io", allowlist)).toBe(false);
  });

  it("returns false for empty allowlist", () => {
    expect(isAllowed("anything.com", [])).toBe(false);
  });
});

describe("isPrivateIp", () => {
  // IPv4 private/loopback ranges
  it("detects 127.0.0.1 as private (loopback)", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  it("detects 127.255.255.255 as private (loopback /8)", () => {
    expect(isPrivateIp("127.255.255.255")).toBe(true);
  });

  it("detects 10.0.0.1 as private (RFC-1918 /8)", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
  });

  it("detects 172.16.0.1 as private (RFC-1918 /12 lower)", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
  });

  it("detects 172.31.255.255 as private (RFC-1918 /12 upper)", () => {
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  it("rejects 172.15.0.1 (just below /12 range)", () => {
    expect(isPrivateIp("172.15.0.1")).toBe(false);
  });

  it("rejects 172.32.0.1 (just above /12 range)", () => {
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("detects 192.168.1.1 as private (RFC-1918 /16)", () => {
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("detects 169.254.0.1 as private (link-local)", () => {
    expect(isPrivateIp("169.254.0.1")).toBe(true);
  });

  it("detects 0.0.0.0 as private", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  // IPv6
  it("detects ::1 as private (IPv6 loopback)", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  it("detects fc00::1 as private (IPv6 ULA)", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
  });

  it("detects fd12::1 as private (IPv6 ULA)", () => {
    expect(isPrivateIp("fd12::1")).toBe(true);
  });

  it("detects fe80::1 as private (IPv6 link-local)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
  });

  // Public IPs
  it("accepts 8.8.8.8 as public", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("accepts 1.2.3.4 as public", () => {
    expect(isPrivateIp("1.2.3.4")).toBe(false);
  });

  it("accepts 203.0.113.1 as public", () => {
    expect(isPrivateIp("203.0.113.1")).toBe(false);
  });
});

describe("McpProxyServer", () => {
  it("generates a unique auth token", () => {
    const proxy = new McpProxyServer({ port: 0, allowlist: [] });
    expect(proxy.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates different tokens per instance", () => {
    const a = new McpProxyServer({ port: 0, allowlist: [] });
    const b = new McpProxyServer({ port: 0, allowlist: [] });
    expect(a.token).not.toBe(b.token);
  });
});

describe("McpProxyServer HTTP handler", () => {
  let proxy: McpProxyServer;
  let port: number;

  // Use a random high port to avoid conflicts
  const getPort = (): number => 10000 + Math.floor(Math.random() * 50000);

  afterAll(async () => {
    if (proxy) await proxy.stop().catch(() => undefined);
  });

  it("rejects HTTP request without auth (407)", async () => {
    port = getPort();
    proxy = new McpProxyServer({ port, allowlist: ["example.com"] });
    await proxy.start();

    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${port}`,
        { method: "GET", path: "http://example.com/", headers: {} },
        resolve,
      );
      req.end();
    });
    expect(res.statusCode).toBe(407);
    await proxy.stop();
  });

  it("rejects HTTP request with wrong token (407)", async () => {
    port = getPort();
    proxy = new McpProxyServer({ port, allowlist: ["example.com"] });
    await proxy.start();

    const res = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${port}`,
        {
          method: "GET",
          path: "http://example.com/",
          headers: { "proxy-authorization": "Bearer wrong-token" },
        },
        resolve,
      );
      req.end();
    });
    expect(res.statusCode).toBe(407);
    await proxy.stop();
  });
});

describe("McpProxyServer CONNECT port restriction", () => {
  let proxy: McpProxyServer;
  let port: number;

  afterAll(async () => {
    if (proxy) await proxy.stop().catch(() => undefined);
  });

  async function sendConnect(
    targetHost: string,
    targetPort: number,
    token: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
            `Host: ${targetHost}:${targetPort}\r\n` +
            `Proxy-Authorization: Bearer ${token}\r\n` +
            `\r\n`,
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        // Once we get the full response line, resolve
        if (data.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(data.split("\r\n")[0]!);
        }
      });
      socket.on("error", reject);
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("timeout")); });
    });
  }

  it("blocks CONNECT to port 22 (SSH)", async () => {
    port = 10000 + Math.floor(Math.random() * 50000);
    proxy = new McpProxyServer({ port, allowlist: ["example.com"] });
    await proxy.start();

    const response = await sendConnect("example.com", 22, proxy.token);
    expect(response).toContain("403");
    await proxy.stop();
  });

  it("blocks CONNECT to port 6379 (Redis)", async () => {
    port = 10000 + Math.floor(Math.random() * 50000);
    proxy = new McpProxyServer({ port, allowlist: ["example.com"] });
    await proxy.start();

    const response = await sendConnect("example.com", 6379, proxy.token);
    expect(response).toContain("403");
    await proxy.stop();
  });

  it("rejects CONNECT without auth (407)", async () => {
    port = 10000 + Math.floor(Math.random() * 50000);
    proxy = new McpProxyServer({ port, allowlist: ["example.com"] });
    await proxy.start();

    const response = await sendConnect("example.com", 443, "wrong-token");
    expect(response).toContain("407");
    await proxy.stop();
  });
});

describe("McpProxyServer start/stop", () => {
  it("rejects start() when port is in use", async () => {
    const port = 10000 + Math.floor(Math.random() * 50000);
    const p1 = new McpProxyServer({ port, allowlist: [] });
    await p1.start();

    const p2 = new McpProxyServer({ port, allowlist: [] });
    await expect(p2.start()).rejects.toThrow();

    await p1.stop();
  });

  it("stop() resolves cleanly", async () => {
    const port = 10000 + Math.floor(Math.random() * 50000);
    const proxy = new McpProxyServer({ port, allowlist: [] });
    await proxy.start();
    await expect(proxy.stop()).resolves.toBeUndefined();
  });
});
