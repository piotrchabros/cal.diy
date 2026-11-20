// @vitest-environment node
import type { IncomingHttpHeaders, Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AGENT_BROWSER_VIEWPORT,
  agentBrowserViewerMessageSchema,
  signAgentBrowserViewerToken,
} from "@calcom/lib/agentBrowser/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createSilentLogger } from "../logger";
import { FakeBrowserDriver } from "../sessions/FakeBrowserDriver";
import { SessionManager } from "../sessions/SessionManager";
import { ViewerHub } from "../viewer/ViewerHub";
import type { ViewerServer } from "./viewerServer";
import { createViewerServer, MAX_CLIENT_MESSAGE_BYTES } from "./viewerServer";

const SECRET = "viewer-server-test-secret-0123456789abcdef";
const OTHER_SECRET = "another-viewer-secret-0123456789abcdefghij";
const GOTO = { type: "goto", url: "https://example.com/" } as const;

type Reply = { status: number; headers: IncomingHttpHeaders; text: string };

type Received = { messages: unknown[]; frames: Buffer[] };

const tokenFor = (botId: string, options: { secret?: string; issuedAt?: Date; ttlSeconds?: number } = {}) =>
  signAgentBrowserViewerToken({
    secret: options.secret ?? SECRET,
    botId,
    issuedAt: options.issuedAt ?? new Date(Date.now() - 10_000),
    ttlSeconds: options.ttlSeconds ?? 3600,
  });

describe("viewerServer", () => {
  let driver: FakeBrowserDriver;
  let hub: ViewerHub;
  let sessions: SessionManager;
  let viewer: ViewerServer;
  let server: Server;
  let port: number;
  let sockets: WebSocket[];

  beforeEach(async () => {
    driver = new FakeBrowserDriver();
    hub = new ViewerHub({ logger: createSilentLogger(), maxViewersPerBot: 2 });
    sessions = new SessionManager({
      driver,
      hub,
      maxSessions: 2,
      idleTimeoutMs: 600_000,
      maxSessionMs: 18_000_000,
      logger: createSilentLogger(),
    });
    viewer = createViewerServer({ secret: SECRET, sessions, hub, logger: createSilentLogger() });
    server = viewer.server;
    sockets = [];
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const ws of sockets) {
      // A socket whose upgrade was refused emits an error when terminated; it is already gone.
      ws.on("error", () => {});
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    await viewer.close();
  });

  function get(path: string, method = "GET"): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          })
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  const wsUrl = (token: string, path = "/agent-browser/ws") =>
    `ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`;

  // Resolves with the received messages once the server's greeting has arrived.
  function connect(
    token: string,
    options: WebSocket.ClientOptions = {}
  ): Promise<{ ws: WebSocket } & Received> {
    const ws = new WebSocket(wsUrl(token), options);
    sockets.push(ws);
    const received: Received = { messages: [], frames: [] };
    ws.on("message", (data, isBinary) => {
      if (isBinary) received.frames.push(Buffer.from(data as Buffer));
      else received.messages.push(agentBrowserViewerMessageSchema.parse(JSON.parse(String(data))));
    });
    return new Promise((resolve, reject) => {
      ws.once("message", () => resolve({ ws, ...received }));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  function rejectedStatus(token: string, path?: string): Promise<number> {
    const ws = new WebSocket(wsUrl(token, path));
    sockets.push(ws);
    return new Promise((resolve, reject) => {
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => reject(new Error("upgrade was accepted")));
    });
  }

  const closeOf = (ws: WebSocket): Promise<number> =>
    new Promise((resolve) => ws.once("close", (code) => resolve(code)));

  const until = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(condition()).toBe(true);
  };

  describe("GET /agent-browser/view", () => {
    it("serves the page with a strict CSP whose nonce matches the inline script", async () => {
      const token = tokenFor("bot1");
      const reply = await get(`/agent-browser/view?token=${encodeURIComponent(token)}`);

      expect(reply.status).toBe(200);
      expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["referrer-policy"]).toBe("no-referrer");
      const csp = String(reply.headers["content-security-policy"]);
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(reply.text).toContain(`<script nonce="${nonce}">`);
      expect(reply.text).toContain(`width="${AGENT_BROWSER_VIEWPORT.width}"`);
      expect(reply.text).not.toContain(token);
    });

    it("uses a fresh nonce per response", async () => {
      const path = `/agent-browser/view?token=${encodeURIComponent(tokenFor("bot1"))}`;
      const [a, b] = await Promise.all([get(path), get(path)]);
      expect(a.headers["content-security-policy"]).not.toBe(b.headers["content-security-policy"]);
    });

    it.each([
      ["missing", ""],
      ["garbage", "token=not-a-token"],
      ["wrong secret", `token=${tokenFor("bot1", { secret: OTHER_SECRET })}`],
      ["expired", `token=${tokenFor("bot1", { issuedAt: new Date(Date.now() - 7200_000), ttlSeconds: 60 })}`],
    ])("answers 401 HTML for a %s token", async (_label, query) => {
      const reply = await get(`/agent-browser/view?${query}`);

      expect(reply.status).toBe(401);
      expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(reply.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'");
      expect(reply.text).not.toContain("<script");
    });

    it("answers 401 for a token issued before the session was closed", async () => {
      const token = tokenFor("bot1");
      await sessions.destroy("bot1");

      const reply = await get(`/agent-browser/view?token=${encodeURIComponent(token)}`);

      expect(reply.status).toBe(401);
    });

    it.each([
      ["GET", "/"],
      ["GET", "/agent-browser/view/extra"],
      ["POST", "/agent-browser/view"],
      ["GET", "/healthz"],
    ])("answers 404 for %s %s", async (method, path) => {
      const reply = await get(`${path}?token=${encodeURIComponent(tokenFor("bot1"))}`, method);
      expect(reply.status).toBe(404);
    });
  });

  describe("WebSocket /agent-browser/ws", () => {
    it.each([
      ["garbage", () => "not-a-token"],
      ["wrong secret", () => tokenFor("bot1", { secret: OTHER_SECRET })],
    ])("rejects a %s token with 401 before the upgrade", async (_label, token) => {
      expect(await rejectedStatus(token())).toBe(401);
      expect(hub.total()).toBe(0);
    });

    it("rejects a revoked token with 401", async () => {
      const token = tokenFor("bot1");
      await sessions.destroy("bot1");

      expect(await rejectedStatus(token)).toBe(401);
    });

    it("rejects an upgrade on another path with 404", async () => {
      expect(await rejectedStatus(tokenFor("bot1"), "/agent-browser/view")).toBe(404);
    });

    it("rejects a viewer over the per-bot cap with 429", async () => {
      const token = tokenFor("bot1");
      await connect(token);
      await connect(token);

      expect(await rejectedStatus(token)).toBe(429);
      expect(hub.count("bot1")).toBe(2);
    });

    it("greets a viewer of a bot without a session as waiting", async () => {
      const { messages } = await connect(tokenFor("bot1"));

      expect(messages).toEqual([
        {
          t: "hello",
          width: AGENT_BROWSER_VIEWPORT.width,
          height: AGENT_BROWSER_VIEWPORT.height,
          state: "waiting",
        },
      ]);
      expect(hub.count("bot1")).toBe(1);
    });

    it("goes live when a session opens and fans binary frames out to every viewer", async () => {
      const a = await connect(tokenFor("bot1"));
      const b = await connect(tokenFor("bot1"));
      const other = await connect(tokenFor("bot2"));

      await sessions.perform("bot1", GOTO);
      driver.lastSession("bot1")?.emitFrame(Buffer.from("jpeg-1"));

      await until(() => a.frames.length === 1 && b.frames.length === 1);
      for (const received of [a, b]) {
        expect(received.messages).toContainEqual({ t: "state", state: "live" });
        expect(received.messages).toContainEqual({
          t: "page",
          url: GOTO.url,
          title: `Title of ${GOTO.url}`,
        });
        expect(received.frames[0]?.toString()).toBe("jpeg-1");
      }
      expect(other.frames).toEqual([]);
    });

    it("tells viewers the session closed and disconnects them", async () => {
      const a = await connect(tokenFor("bot1"));
      await sessions.perform("bot1", GOTO);
      const closed = closeOf(a.ws);

      await sessions.destroy("bot1");

      expect(await closed).toBe(1000);
      expect(a.messages.at(-1)).toEqual({ t: "state", state: "closed" });
    });

    it("closes with 1008 when the client sends an oversized message", async () => {
      const { ws } = await connect(tokenFor("bot1"));
      const closed = closeOf(ws);

      ws.send(Buffer.alloc(MAX_CLIENT_MESSAGE_BYTES + 1));

      expect(await closed).toBe(1008);
      await until(() => hub.count("bot1") === 0);
    });

    it("ignores a small client message", async () => {
      const { ws } = await connect(tokenFor("bot1"));
      ws.send("hi");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it("keeps a viewer that answers pings", async () => {
      const { ws } = await connect(tokenFor("bot1"));
      let pongs = 0;
      ws.on("ping", () => {
        pongs += 1;
      });

      for (let round = 1; round <= 3; round += 1) {
        viewer.checkHeartbeats();
        await until(() => pongs === round);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(hub.count("bot1")).toBe(1);
    });

    it("terminates a viewer after two missed pongs", async () => {
      const { ws } = await connect(tokenFor("bot1"), { autoPong: false });
      const closed = closeOf(ws);

      viewer.checkHeartbeats();
      viewer.checkHeartbeats();
      expect(ws.readyState).toBe(WebSocket.OPEN);
      viewer.checkHeartbeats();

      expect(await closed).toBe(1006);
      await until(() => hub.count("bot1") === 0);
    });
  });
});
