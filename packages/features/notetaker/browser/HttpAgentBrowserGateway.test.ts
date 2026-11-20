import {
  AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS,
  type AgentBrowserPageState,
  buildAgentBrowserAuthorization,
  verifyAgentBrowserViewerToken,
} from "@calcom/lib/agentBrowser/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAgentBrowserGateway } from "./HttpAgentBrowserGateway";
import { getAgentBrowserGatewayErrorInfo } from "./IAgentBrowserGateway";

const SECRET = "s".repeat(40);
const INTERNAL_URL = "http://127.0.0.1:4410";
const PUBLIC_URL = "https://cal.example.com/agent-browser";
const BOT_ID = "bot_1";

type Call = { url: string; init: RequestInit };

const pageState: AgentBrowserPageState = {
  created: true,
  url: "https://example.com/",
  title: "Example",
  snapshot: 'Elements:\n[e1] link "More"',
  viewers: 0,
  screenshot: null,
};

function jsonResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function setup(
  responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>,
  overrides: Partial<ConstructorParameters<typeof HttpAgentBrowserGateway>[0]> = {}
) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init ?? {});
    return next;
  }) as unknown as typeof fetch;
  const gateway = new HttpAgentBrowserGateway({
    internalUrl: INTERNAL_URL,
    publicUrl: PUBLIC_URL,
    secret: SECRET,
    viewerTokenTtlSeconds: 4200,
    fetchFn,
    ...overrides,
  });
  return { gateway, calls };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function hangingUntilAborted(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HttpAgentBrowserGateway.perform", () => {
  it("posts the action with the bearer derived from the secret and returns the page state", async () => {
    const { gateway, calls } = setup([jsonResponse(200, pageState)]);

    const result = await gateway.perform(BOT_ID, { type: "goto", url: "https://example.com" });

    expect(result).toEqual(pageState);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${INTERNAL_URL}/v1/sessions/${BOT_ID}/actions`);
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(buildAgentBrowserAuthorization(SECRET));
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ type: "goto", url: "https://example.com" });
  });

  it("strips trailing slashes from the internal URL", async () => {
    const { gateway, calls } = setup([jsonResponse(200, pageState)], { internalUrl: `${INTERNAL_URL}//` });

    await gateway.perform(BOT_ID, { type: "snapshot" });

    expect(calls[0].url).toBe(`${INTERNAL_URL}/v1/sessions/${BOT_ID}/actions`);
  });

  it("gives UNAVAILABLE when a success response does not match the contract", async () => {
    const { gateway } = setup([jsonResponse(200, { ...pageState, viewers: -1 })]);

    const error = await captureError(gateway.perform(BOT_ID, { type: "snapshot" }));

    expect(getAgentBrowserGatewayErrorInfo(error)).toEqual({ kind: "UNAVAILABLE" });
  });

  it("gives UNAVAILABLE when a success response is not JSON", async () => {
    const { gateway } = setup([jsonResponse(200, "<html>")]);

    const error = await captureError(gateway.perform(BOT_ID, { type: "snapshot" }));

    expect(getAgentBrowserGatewayErrorInfo(error)).toEqual({ kind: "UNAVAILABLE" });
  });

  it.each([
    [400, "INVALID_INPUT"],
    [401, "UNAUTHORIZED"],
    [404, "SESSION_NOT_FOUND"],
    [409, "STALE_REF"],
    [422, "BLOCKED_URL"],
    [422, "ACTION_FAILED"],
    [429, "CAPACITY"],
    [504, "TIMEOUT"],
    [500, "INTERNAL"],
  ] as const)("maps an HTTP %i error body with %s to that kind", async (status, code) => {
    const { gateway } = setup([jsonResponse(status, { error: code, message: "short message" })]);

    const error = await captureError(gateway.perform(BOT_ID, { type: "click", ref: "e1" }));

    expect(getAgentBrowserGatewayErrorInfo(error)).toEqual({ kind: code });
    expect((error as Error).message).toContain("short message");
  });

  it("gives UNAVAILABLE for an error status without a contract body", async () => {
    const { gateway } = setup([jsonResponse(502, "Bad gateway")]);

    const error = await captureError(gateway.perform(BOT_ID, { type: "snapshot" }));

    expect(getAgentBrowserGatewayErrorInfo(error)).toEqual({ kind: "UNAVAILABLE" });
    expect((error as Error).message).toContain("HTTP 502");
  });

  it("gives UNAVAILABLE on a network error", async () => {
    const { gateway } = setup([new TypeError("fetch failed")]);

    const error = await captureError(gateway.perform(BOT_ID, { type: "snapshot" }));

    expect(getAgentBrowserGatewayErrorInfo(error)).toEqual({ kind: "UNAVAILABLE" });
  });

  it("gives UNAVAILABLE when the request times out", async () => {
    vi.useFakeTimers();
    const { gateway } = setup([hangingUntilAborted], { timeoutMs: 1000 });

    const pending = captureError(gateway.perform(BOT_ID, { type: "snapshot" }));
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;

    expect(getAgentBrowserGatewayErrorInfo(error)).toEqual({ kind: "UNAVAILABLE" });
    expect((error as Error).message).toContain("timed out");
  });

  it("rejects an invalid botId without calling agent-browser", async () => {
    const { gateway, calls } = setup([]);

    const error = await captureError(gateway.perform("bot.1", { type: "snapshot" }));

    expect(getAgentBrowserGatewayErrorInfo(error)).toEqual({ kind: "INVALID_INPUT" });
    expect(calls).toHaveLength(0);
  });
});

describe("HttpAgentBrowserGateway.closeSession", () => {
  it("sends an authorized DELETE without a body", async () => {
    const { gateway, calls } = setup([jsonResponse(204, null)]);

    await gateway.closeSession(BOT_ID);

    expect(calls[0].url).toBe(`${INTERNAL_URL}/v1/sessions/${BOT_ID}`);
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].init.body).toBeUndefined();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(buildAgentBrowserAuthorization(SECRET));
  });

  it("gives UNAVAILABLE on a network error", async () => {
    const { gateway } = setup([new TypeError("fetch failed")]);

    const error = await captureError(gateway.closeSession(BOT_ID));

    expect(getAgentBrowserGatewayErrorInfo(error)).toEqual({ kind: "UNAVAILABLE" });
  });

  it("maps an error body to its kind", async () => {
    const { gateway } = setup([jsonResponse(401, { error: "UNAUTHORIZED", message: "no" })]);

    const error = await captureError(gateway.closeSession(BOT_ID));

    expect(getAgentBrowserGatewayErrorInfo(error)).toEqual({ kind: "UNAUTHORIZED" });
  });
});

describe("HttpAgentBrowserGateway.buildViewerUrl", () => {
  const now = new Date("2026-11-20T10:00:00.000Z");

  function tokenFrom(url: string): string {
    const token = new URL(url).searchParams.get("token");
    if (!token) throw new Error("no token in viewer URL");
    return token;
  }

  it("builds a public view URL whose token verifies with the contract", () => {
    const { gateway } = setup([], { publicUrl: `${PUBLIC_URL}/` });

    const url = gateway.buildViewerUrl(BOT_ID, now);

    expect(url.startsWith(`${PUBLIC_URL}/view?token=`)).toBe(true);
    const verified = verifyAgentBrowserViewerToken({ secret: SECRET, token: tokenFrom(url), now });
    expect(verified).toEqual({
      botId: BOT_ID,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 4200 * 1000),
    });
  });

  it("caps the token lifetime at the contract maximum", () => {
    const { gateway } = setup([], { viewerTokenTtlSeconds: AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS + 600 });

    const verified = verifyAgentBrowserViewerToken({
      secret: SECRET,
      token: tokenFrom(gateway.buildViewerUrl(BOT_ID, now)),
      now,
    });

    expect(verified?.expiresAt).toEqual(new Date(now.getTime() + AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS * 1000));
  });

  it("does not verify with another secret", () => {
    const { gateway } = setup([]);

    const token = tokenFrom(gateway.buildViewerUrl(BOT_ID, now));

    expect(verifyAgentBrowserViewerToken({ secret: "x".repeat(40), token, now })).toBeNull();
  });
});
