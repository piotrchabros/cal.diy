// @vitest-environment node
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  agentBrowserHealthSchema,
  buildAgentBrowserAuthorization,
  signAgentBrowserViewerToken,
} from "@calcom/lib/agentBrowser/contract";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createSilentLogger } from "./logger";
import { FakeBrowserDriver } from "./sessions/FakeBrowserDriver";
import type { StartedAgentBrowser } from "./startAgentBrowser";
import { startAgentBrowser } from "./startAgentBrowser";

const SECRET = "start-agent-browser-test-secret-0123456789";

const ENV = {
  AGENT_BROWSER_SECRET: SECRET,
  AGENT_BROWSER_HOST: "127.0.0.1",
  AGENT_BROWSER_CONTROL_PORT: "0",
  AGENT_BROWSER_VIEWER_PORT: "0",
  AGENT_BROWSER_LOG_LEVEL: "silent",
};

const portOf = (server: Server) => (server.address() as AddressInfo).port;

// node:http rather than fetch, which the shared vitest setup replaces with a mock.
function send(
  server: Server,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: portOf(server),
        path,
        method: options.method ?? "GET",
        agent: false,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    req.end(options.body ?? "");
  });
}

describe("startAgentBrowser", () => {
  let started: StartedAgentBrowser | null = null;

  afterEach(async () => {
    await started?.close();
    started = null;
  });

  it("rejects an invalid configuration without echoing the secret", async () => {
    const secret = "short-secret-value";

    const error = await startAgentBrowser({ ...ENV, AGENT_BROWSER_SECRET: secret }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("AGENT_BROWSER_SECRET");
    expect((error as Error).message).not.toContain(secret);
  });

  it("wires the control API, viewer and driver together and shuts down as a restart", async () => {
    const driver = new FakeBrowserDriver();
    started = await startAgentBrowser(ENV, { createDriver: () => driver, logger: createSilentLogger() });
    const { controlServer, viewerServer } = started;

    const health = await send(controlServer, "/healthz");
    expect(agentBrowserHealthSchema.parse(JSON.parse(health.text))).toMatchObject({
      sessions: 0,
      maxSessions: 4,
    });

    const unauthorized = await send(viewerServer, "/agent-browser/view?token=bad");
    expect(unauthorized.status).toBe(401);

    const token = signAgentBrowserViewerToken({
      secret: SECRET,
      botId: "bot1",
      issuedAt: new Date(Date.now() - 10_000),
      ttlSeconds: 3600,
    });
    const ws = new WebSocket(
      `ws://127.0.0.1:${portOf(viewerServer)}/agent-browser/ws?token=${encodeURIComponent(token)}`
    );
    const frames: Buffer[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) frames.push(Buffer.from(data as Buffer));
    });
    await new Promise((resolve, reject) => {
      ws.once("message", resolve);
      ws.once("error", reject);
    });

    const action = await send(controlServer, "/v1/sessions/bot1/actions", {
      method: "POST",
      headers: { authorization: buildAgentBrowserAuthorization(SECRET), "content-type": "application/json" },
      body: JSON.stringify({ type: "goto", url: "https://example.com/" }),
    });
    expect(action.status).toBe(200);
    expect(JSON.parse(action.text)).toMatchObject({ created: true, viewers: 1 });

    driver.lastSession("bot1")?.emitFrame(Buffer.from("jpeg"));
    for (let attempt = 0; attempt < 100 && frames.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(frames.map(String)).toEqual(["jpeg"]);

    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    await started.close();

    expect(await closed).toBe(1012);
    expect(driver.lastSession("bot1")?.disposed).toBe(true);
    expect(driver.closed).toBe(true);
    expect(controlServer.listening).toBe(false);
    expect(viewerServer.listening).toBe(false);
  });
});
