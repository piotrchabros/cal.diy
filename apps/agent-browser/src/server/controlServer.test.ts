// @vitest-environment node
import type { IncomingHttpHeaders, Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentBrowserErrorCode } from "@calcom/lib/agentBrowser/contract";
import {
  agentBrowserErrorResponseSchema,
  agentBrowserHealthSchema,
  agentBrowserPageStateSchema,
  buildAgentBrowserAuthorization,
} from "@calcom/lib/agentBrowser/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSilentLogger } from "../logger";
import { FakeBrowserDriver } from "../sessions/FakeBrowserDriver";
import { AgentBrowserActionError } from "../sessions/IBrowserDriver";
import { SessionManager } from "../sessions/SessionManager";
import type { ViewerSocket } from "../viewer/ViewerHub";
import { ViewerHub } from "../viewer/ViewerHub";
import { createControlServer, MAX_CONTROL_BODY_BYTES } from "./controlServer";

const SECRET = "test-secret-not-real-0123456789abcdef";
const OTHER_SECRET = "another-test-secret-not-real-0123456789";
const AUTHORIZATION = buildAgentBrowserAuthorization(SECRET);
const GOTO_BODY = JSON.stringify({ type: "goto", url: "https://example.com/" });

type Reply = { status: number; headers: IncomingHttpHeaders; text: string };

type SendInput = {
  method: string;
  path: string;
  body?: string;
  authorization?: string | null;
  headers?: Record<string, string>;
};

class FakeSocket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<string | Buffer> = [];
  closed = false;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  once(): void {}
}

describe("controlServer", () => {
  let driver: FakeBrowserDriver;
  let hub: ViewerHub;
  let sessions: SessionManager;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    driver = new FakeBrowserDriver();
    hub = new ViewerHub({ logger: createSilentLogger() });
    sessions = new SessionManager({
      driver,
      hub,
      maxSessions: 1,
      idleTimeoutMs: 600_000,
      maxSessionMs: 18_000_000,
      logger: createSilentLogger(),
    });
    server = createControlServer({
      secret: SECRET,
      sessions,
      hub,
      version: "1.2.3",
      logger: createSilentLogger(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // node:http rather than fetch, so connection and CORS headers are visible exactly as sent.
  function send(input: SendInput): Promise<Reply> {
    const body = input.body ?? "";
    const headers: Record<string, string | number> = { ...input.headers };
    if (body) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const authorization = input.authorization === undefined ? AUTHORIZATION : input.authorization;
    if (authorization !== null) headers.authorization = authorization;

    return new Promise<Reply>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: input.path, method: input.method, agent: false, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            })
          );
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  const act = (botId: string, body: string, authorization?: string | null): Promise<Reply> =>
    send({ method: "POST", path: `/v1/sessions/${botId}/actions`, body, authorization });

  const expectError = (reply: Reply, status: number, code: AgentBrowserErrorCode): void => {
    expect(reply.status).toBe(status);
    expect(reply.headers["content-type"]).toBe("application/json");
    const parsed = agentBrowserErrorResponseSchema.parse(JSON.parse(reply.text));
    expect(parsed.error).toBe(code);
  };

  describe("healthz", () => {
    it("answers without auth with the contract shape", async () => {
      await act("bot1", GOTO_BODY);
      hub.add("bot1", new FakeSocket());

      const reply = await send({ method: "GET", path: "/healthz", authorization: null });

      expect(reply.status).toBe(200);
      expect(agentBrowserHealthSchema.parse(JSON.parse(reply.text))).toEqual({
        ok: true,
        sessions: 1,
        maxSessions: 1,
        viewers: 1,
        version: "1.2.3",
      });
    });
  });

  describe("auth", () => {
    it.each([
      ["missing", null],
      ["wrong secret", buildAgentBrowserAuthorization(OTHER_SECRET)],
      ["wrong scheme", AUTHORIZATION.replace("Bearer ", "Basic ")],
      ["truncated", AUTHORIZATION.slice(0, -1)],
    ])("rejects a %s bearer with 401 and touches no session", async (_label, authorization) => {
      const reply = await act("bot1", GOTO_BODY, authorization);

      expectError(reply, 401, "UNAUTHORIZED");
      expect(driver.sessions).toHaveLength(0);
    });

    it("rejects DELETE and unknown routes without a bearer with 401", async () => {
      expectError(
        await send({ method: "DELETE", path: "/v1/sessions/bot1", authorization: null }),
        401,
        "UNAUTHORIZED"
      );
      expectError(
        await send({ method: "GET", path: "/v1/anything", authorization: null }),
        401,
        "UNAUTHORIZED"
      );
    });

    it("answers 401, not 413, to an unauthenticated oversized body", async () => {
      const reply = await act("bot1", "a".repeat(MAX_CONTROL_BODY_BYTES + 1), null);

      expectError(reply, 401, "UNAUTHORIZED");
      expect(reply.headers.connection).toBe("close");
    });
  });

  describe("input", () => {
    it("answers 413 to a body over 16 KB and closes the connection", async () => {
      const reply = await act("bot1", "a".repeat(MAX_CONTROL_BODY_BYTES + 1));

      expect(MAX_CONTROL_BODY_BYTES).toBe(16_384);
      expectError(reply, 413, "INVALID_INPUT");
      expect(reply.headers.connection).toBe("close");
      expect(driver.sessions).toHaveLength(0);
    });

    it.each([
      ["not JSON", "{"],
      ["an unknown action", JSON.stringify({ type: "hover" })],
      ["a bad ref", JSON.stringify({ type: "click", ref: "x1" })],
      ["an empty body", ""],
    ])("answers 400 to %s", async (_label, body) => {
      expectError(await act("bot1", body), 400, "INVALID_INPUT");
      expect(driver.sessions).toHaveLength(0);
    });

    it("answers 400 to a bot id outside the contract", async () => {
      expectError(await act("bot.1", GOTO_BODY), 400, "INVALID_INPUT");
      expectError(
        await send({ method: "DELETE", path: `/v1/sessions/${"a".repeat(65)}` }),
        400,
        "INVALID_INPUT"
      );
    });

    it("answers 404 with no body to an unknown route or method", async () => {
      for (const input of [
        { method: "GET", path: "/v1/sessions/bot1/actions" },
        { method: "POST", path: "/v1/sessions/bot1" },
        { method: "POST", path: "/v1/sessions/bot1/other" },
        { method: "GET", path: "/" },
      ]) {
        const reply = await send(input);
        expect(reply.status).toBe(404);
        expect(reply.text).toBe("");
      }
    });
  });

  describe("actions", () => {
    it("returns the page state for goto and then for other actions", async () => {
      const first = await act("bot1", GOTO_BODY);
      expect(first.status).toBe(200);
      expect(agentBrowserPageStateSchema.parse(JSON.parse(first.text))).toEqual({
        created: true,
        url: "https://example.com/",
        title: "Title of https://example.com/",
        snapshot: "Fake snapshot of https://example.com/",
        viewers: 0,
        screenshot: null,
      });

      const second = await act("bot1", JSON.stringify({ type: "screenshot" }));
      const state = agentBrowserPageStateSchema.parse(JSON.parse(second.text));
      expect(state.created).toBe(false);
      expect(state.screenshot?.mediaType).toBe("image/jpeg");
    });

    it("answers 404 SESSION_NOT_FOUND to a non-goto action without a session", async () => {
      expectError(await act("bot1", JSON.stringify({ type: "snapshot" })), 404, "SESSION_NOT_FOUND");
    });

    it("answers 429 CAPACITY when every session slot is taken", async () => {
      await act("bot1", GOTO_BODY);
      expectError(await act("bot2", GOTO_BODY), 429, "CAPACITY");
    });

    it.each([
      ["BLOCKED_URL", 422],
      ["STALE_REF", 409],
      ["ACTION_FAILED", 422],
      ["TIMEOUT", 504],
      ["INTERNAL", 500],
      ["INVALID_INPUT", 400],
    ] as const)("maps %s to %i with the error's message", async (code, status) => {
      await act("bot1", GOTO_BODY);
      driver.lastSession("bot1")?.failNext(new AgentBrowserActionError(code, "Short message."));

      const reply = await act("bot1", JSON.stringify({ type: "snapshot" }));

      expectError(reply, status, code);
      expect(JSON.parse(reply.text).message).toBe("Short message.");
    });

    it("never passes through the text of an unexpected error", async () => {
      await act("bot1", GOTO_BODY);
      driver.lastSession("bot1")?.failNext(new Error("page.click: secret page content"));

      const reply = await act("bot1", JSON.stringify({ type: "snapshot" }));

      expectError(reply, 500, "INTERNAL");
      expect(reply.text).not.toContain("secret page content");
    });
  });

  describe("delete", () => {
    it("is 204 and idempotent, and disposes the session", async () => {
      await act("bot1", GOTO_BODY);

      const first = await send({ method: "DELETE", path: "/v1/sessions/bot1" });
      const second = await send({ method: "DELETE", path: "/v1/sessions/bot1" });
      const never = await send({ method: "DELETE", path: "/v1/sessions/bot9" });

      for (const reply of [first, second, never]) {
        expect(reply.status).toBe(204);
        expect(reply.text).toBe("");
      }
      expect(driver.lastSession("bot1")?.disposed).toBe(true);
      expect(sessions.stats().sessions).toBe(0);
      expect(sessions.isRevoked("bot1", new Date(Date.now() - 1000))).toBe(true);
    });
  });

  it("never sends CORS headers, even to a cross-origin preflight", async () => {
    const replies = await Promise.all([
      send({ method: "GET", path: "/healthz", headers: { origin: "https://evil.example" } }),
      send({
        method: "OPTIONS",
        path: "/v1/sessions/bot1/actions",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      }),
      act("bot1", GOTO_BODY),
    ]);

    for (const reply of replies) {
      const corsHeaders = Object.keys(reply.headers).filter((name) => name.startsWith("access-control-"));
      expect(corsHeaders).toEqual([]);
    }
  });
});
