import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENT_BROWSER_KEYS,
  AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS,
  AGENT_BROWSER_MAX_TYPE_LENGTH,
  AGENT_BROWSER_MAX_URL_LENGTH,
  AGENT_BROWSER_SNAPSHOT_MAX_CHARS,
  agentBrowserActionSchema,
  agentBrowserBotIdSchema,
  agentBrowserErrorResponseSchema,
  agentBrowserHealthSchema,
  agentBrowserPageStateSchema,
  agentBrowserViewerMessageSchema,
  buildAgentBrowserAuthorization,
  deriveAgentBrowserKey,
  signAgentBrowserViewerToken,
  verifyAgentBrowserAuthorization,
  verifyAgentBrowserViewerToken,
} from "./contract";

const SECRET = "test-secret-with-enough-length-0123456789";
const BOT_ID = "bot_1234-abcd";
const ISSUED_AT = new Date("2030-01-01T10:00:00.000Z");
const ISSUED_AT_SECONDS = ISSUED_AT.getTime() / 1000;
const TTL_SECONDS = 3600;

function secondsAfterIssue(seconds: number): Date {
  return new Date(ISSUED_AT.getTime() + seconds * 1000);
}

function forgeToken(input: { botId: string; iat: number; exp: number; secret?: string }): string {
  const payload = `v1.${input.botId}.${input.iat}.${input.exp}`;
  const signature = createHmac("sha256", deriveAgentBrowserKey(input.secret ?? SECRET, "viewer-token"))
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

describe("agentBrowserBotIdSchema", () => {
  it("accepts letters, digits, underscores and dashes", () => {
    expect(agentBrowserBotIdSchema.safeParse(BOT_ID).success).toBe(true);
    expect(agentBrowserBotIdSchema.safeParse("a".repeat(64)).success).toBe(true);
  });

  it.each(["", "a".repeat(65), "bot.1", "bot/1", "bot 1"])("rejects %j", (botId) => {
    expect(agentBrowserBotIdSchema.safeParse(botId).success).toBe(false);
  });
});

describe("deriveAgentBrowserKey", () => {
  it("derives distinct 32-byte keys per purpose", () => {
    const internal = deriveAgentBrowserKey(SECRET, "internal-api");
    const viewer = deriveAgentBrowserKey(SECRET, "viewer-token");

    expect(internal).toHaveLength(32);
    expect(viewer).toHaveLength(32);
    expect(internal.equals(viewer)).toBe(false);
    expect(
      internal.equals(createHmac("sha256", SECRET).update("agent-browser/internal-api/v1").digest())
    ).toBe(true);
  });
});

describe("agent browser authorization header", () => {
  it("builds a Bearer header with the hex internal-api key", () => {
    expect(buildAgentBrowserAuthorization(SECRET)).toBe(
      `Bearer ${deriveAgentBrowserKey(SECRET, "internal-api").toString("hex")}`
    );
  });

  it("verifies the header it builds", () => {
    expect(verifyAgentBrowserAuthorization(SECRET, buildAgentBrowserAuthorization(SECRET))).toBe(true);
  });

  it("rejects a header built from another secret", () => {
    expect(verifyAgentBrowserAuthorization(SECRET, buildAgentBrowserAuthorization("other-secret"))).toBe(
      false
    );
  });

  it.each([null, undefined, ""])("rejects a missing header (%j)", (header) => {
    expect(verifyAgentBrowserAuthorization(SECRET, header)).toBe(false);
  });

  it("rejects headers of the wrong length", () => {
    const valid = buildAgentBrowserAuthorization(SECRET);

    expect(verifyAgentBrowserAuthorization(SECRET, valid.slice(0, -1))).toBe(false);
    expect(verifyAgentBrowserAuthorization(SECRET, `${valid}0`)).toBe(false);
    expect(verifyAgentBrowserAuthorization(SECRET, valid.replace("Bearer ", ""))).toBe(false);
  });

  it("never authenticates with an empty secret", () => {
    expect(verifyAgentBrowserAuthorization("", buildAgentBrowserAuthorization(""))).toBe(false);
  });
});

describe("agent browser viewer token", () => {
  const token = signAgentBrowserViewerToken({
    secret: SECRET,
    botId: BOT_ID,
    issuedAt: ISSUED_AT,
    ttlSeconds: TTL_SECONDS,
  });

  it("uses the v1.<botId>.<iat>.<exp>.<sig> format", () => {
    expect(token).toBe(
      forgeToken({ botId: BOT_ID, iat: ISSUED_AT_SECONDS, exp: ISSUED_AT_SECONDS + TTL_SECONDS })
    );
    expect(token.split(".")).toHaveLength(5);
  });

  it("round-trips the botId and times", () => {
    expect(verifyAgentBrowserViewerToken({ secret: SECRET, token, now: secondsAfterIssue(10) })).toEqual({
      botId: BOT_ID,
      issuedAt: ISSUED_AT,
      expiresAt: secondsAfterIssue(TTL_SECONDS),
    });
  });

  it("rejects an expired token, including exactly at expiry", () => {
    expect(
      verifyAgentBrowserViewerToken({ secret: SECRET, token, now: secondsAfterIssue(TTL_SECONDS) })
    ).toBeNull();
    expect(
      verifyAgentBrowserViewerToken({ secret: SECRET, token, now: secondsAfterIssue(TTL_SECONDS + 1) })
    ).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    expect(verifyAgentBrowserViewerToken({ secret: "other-secret", token, now: ISSUED_AT })).toBeNull();
  });

  it("rejects a tampered botId or expiry", () => {
    const [version, , iat, exp, signature] = token.split(".");
    const otherBot = [version, "other-bot", iat, exp, signature].join(".");
    const extended = [version, BOT_ID, iat, String(Number(exp) + 60), signature].join(".");

    expect(verifyAgentBrowserViewerToken({ secret: SECRET, token: otherBot, now: ISSUED_AT })).toBeNull();
    expect(verifyAgentBrowserViewerToken({ secret: SECRET, token: extended, now: ISSUED_AT })).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const lastChar = token.at(-1) === "A" ? "B" : "A";
    const tampered = `${token.slice(0, -1)}${lastChar}`;

    expect(verifyAgentBrowserViewerToken({ secret: SECRET, token: tampered, now: ISSUED_AT })).toBeNull();
  });

  it("rejects a validly signed token whose TTL exceeds the maximum", () => {
    const oversized = forgeToken({
      botId: BOT_ID,
      iat: ISSUED_AT_SECONDS,
      exp: ISSUED_AT_SECONDS + AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS + 1,
    });

    expect(verifyAgentBrowserViewerToken({ secret: SECRET, token: oversized, now: ISSUED_AT })).toBeNull();
  });

  it("accepts a token issued up to 60 seconds in the future and rejects one beyond", () => {
    const withinSkew = forgeToken({
      botId: BOT_ID,
      iat: ISSUED_AT_SECONDS + 60,
      exp: ISSUED_AT_SECONDS + 60 + TTL_SECONDS,
    });
    const beyondSkew = forgeToken({
      botId: BOT_ID,
      iat: ISSUED_AT_SECONDS + 61,
      exp: ISSUED_AT_SECONDS + 61 + TTL_SECONDS,
    });

    expect(
      verifyAgentBrowserViewerToken({ secret: SECRET, token: withinSkew, now: ISSUED_AT })
    ).not.toBeNull();
    expect(verifyAgentBrowserViewerToken({ secret: SECRET, token: beyondSkew, now: ISSUED_AT })).toBeNull();
  });

  it("rejects a token whose expiry is not after its issue time", () => {
    const inverted = forgeToken({ botId: BOT_ID, iat: ISSUED_AT_SECONDS + 30, exp: ISSUED_AT_SECONDS + 20 });

    expect(verifyAgentBrowserViewerToken({ secret: SECRET, token: inverted, now: ISSUED_AT })).toBeNull();
  });

  it("rejects a botId containing a dot", () => {
    const dotted = forgeToken({
      botId: "bot.1",
      iat: ISSUED_AT_SECONDS,
      exp: ISSUED_AT_SECONDS + TTL_SECONDS,
    });

    expect(verifyAgentBrowserViewerToken({ secret: SECRET, token: dotted, now: ISSUED_AT })).toBeNull();
  });

  it.each([
    "",
    "v1",
    "v1.bot.1.2",
    `v2.${BOT_ID}.${ISSUED_AT_SECONDS}.${ISSUED_AT_SECONDS + TTL_SECONDS}.${"A".repeat(43)}`,
    `v1.${BOT_ID}.abc.${ISSUED_AT_SECONDS + TTL_SECONDS}.${"A".repeat(43)}`,
    `v1.${BOT_ID}.${ISSUED_AT_SECONDS}.${ISSUED_AT_SECONDS + TTL_SECONDS}.short`,
    `v1.${BOT_ID}.${ISSUED_AT_SECONDS}.${ISSUED_AT_SECONDS + TTL_SECONDS}.${"A".repeat(43)}.extra`,
  ])("rejects a malformed token %j", (malformed) => {
    expect(verifyAgentBrowserViewerToken({ secret: SECRET, token: malformed, now: ISSUED_AT })).toBeNull();
  });

  it("never verifies with an empty secret", () => {
    const signedWithEmpty = signAgentBrowserViewerToken({
      secret: "",
      botId: BOT_ID,
      issuedAt: ISSUED_AT,
      ttlSeconds: TTL_SECONDS,
    });

    expect(verifyAgentBrowserViewerToken({ secret: "", token: signedWithEmpty, now: ISSUED_AT })).toBeNull();
  });

  it("refuses to sign an invalid botId or TTL", () => {
    const base = { secret: SECRET, issuedAt: ISSUED_AT };

    expect(() => signAgentBrowserViewerToken({ ...base, botId: "bot.1", ttlSeconds: TTL_SECONDS })).toThrow(
      /invalid botId/
    );
    expect(() => signAgentBrowserViewerToken({ ...base, botId: BOT_ID, ttlSeconds: 0 })).toThrow(
      /ttlSeconds/
    );
    expect(() =>
      signAgentBrowserViewerToken({
        ...base,
        botId: BOT_ID,
        ttlSeconds: AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS + 1,
      })
    ).toThrow(/ttlSeconds/);
    expect(() => signAgentBrowserViewerToken({ ...base, botId: BOT_ID, ttlSeconds: 1.5 })).toThrow(
      /ttlSeconds/
    );
  });
});

describe("agentBrowserActionSchema", () => {
  it.each([
    { type: "goto", url: "https://cal.com/pricing" },
    { type: "snapshot" },
    { type: "click", ref: "e12" },
    { type: "click_text", text: "Pricing" },
    { type: "type", ref: "e3", text: "hello", submit: true },
    { type: "type", ref: "e3", text: "", submit: false },
    { type: "scroll", direction: "down", amount: "page" },
    { type: "scroll", direction: "up", amount: "half" },
    { type: "back" },
    { type: "screenshot" },
  ])("accepts %j", (action) => {
    expect(agentBrowserActionSchema.safeParse(action).success).toBe(true);
  });

  it.each(AGENT_BROWSER_KEYS)("accepts press of %s", (key) => {
    expect(agentBrowserActionSchema.safeParse({ type: "press", key }).success).toBe(true);
  });

  it.each([
    { type: "goto", url: "" },
    { type: "goto", url: `https://example.com/${"a".repeat(AGENT_BROWSER_MAX_URL_LENGTH)}` },
    { type: "goto" },
    { type: "click", ref: "12" },
    { type: "click", ref: "e" },
    { type: "click", ref: "e123456" },
    { type: "click", ref: "[data-ab-ref=e1]" },
    { type: "click_text", text: "   " },
    { type: "click_text", text: "a".repeat(201) },
    { type: "type", ref: "e3", text: "a".repeat(AGENT_BROWSER_MAX_TYPE_LENGTH + 1), submit: false },
    { type: "type", ref: "e3", text: "hello" },
    { type: "press", key: "F5" },
    { type: "press", key: "Control+L" },
    { type: "scroll", direction: "left", amount: "page" },
    { type: "scroll", direction: "down", amount: "full" },
    { type: "evaluate", script: "alert(1)" },
    {},
  ])("rejects %j", (action) => {
    expect(agentBrowserActionSchema.safeParse(action).success).toBe(false);
  });

  it("trims click_text", () => {
    expect(agentBrowserActionSchema.parse({ type: "click_text", text: "  Pricing  " })).toEqual({
      type: "click_text",
      text: "Pricing",
    });
  });
});

describe("agentBrowserPageStateSchema", () => {
  const state = {
    created: true,
    url: "https://cal.com/pricing",
    title: "Pricing",
    snapshot: "[e1] link Home",
    viewers: 0,
    screenshot: null,
  };

  it("accepts a page state with and without a screenshot", () => {
    expect(agentBrowserPageStateSchema.safeParse(state).success).toBe(true);
    expect(
      agentBrowserPageStateSchema.safeParse({
        ...state,
        screenshot: { mediaType: "image/jpeg", base64: "AAAA" },
      }).success
    ).toBe(true);
  });

  it("rejects oversized snapshots, negative viewers and non-JPEG screenshots", () => {
    expect(
      agentBrowserPageStateSchema.safeParse({
        ...state,
        snapshot: "a".repeat(AGENT_BROWSER_SNAPSHOT_MAX_CHARS + 201),
      }).success
    ).toBe(false);
    expect(agentBrowserPageStateSchema.safeParse({ ...state, viewers: -1 }).success).toBe(false);
    expect(agentBrowserPageStateSchema.safeParse({ ...state, title: "a".repeat(301) }).success).toBe(false);
    expect(
      agentBrowserPageStateSchema.safeParse({
        ...state,
        screenshot: { mediaType: "image/png", base64: "AAAA" },
      }).success
    ).toBe(false);
  });
});

describe("agentBrowserErrorResponseSchema and agentBrowserHealthSchema", () => {
  it("accepts known error codes and rejects unknown ones", () => {
    expect(
      agentBrowserErrorResponseSchema.safeParse({ error: "BLOCKED_URL", message: "Blocked" }).success
    ).toBe(true);
    expect(agentBrowserErrorResponseSchema.safeParse({ error: "NOPE", message: "Blocked" }).success).toBe(
      false
    );
    expect(
      agentBrowserErrorResponseSchema.safeParse({ error: "INTERNAL", message: "a".repeat(301) }).success
    ).toBe(false);
  });

  it("requires ok to be true", () => {
    const health = { ok: true, sessions: 1, maxSessions: 4, viewers: 2, version: "1.0.0" };

    expect(agentBrowserHealthSchema.safeParse(health).success).toBe(true);
    expect(agentBrowserHealthSchema.safeParse({ ...health, ok: false }).success).toBe(false);
  });
});

describe("agentBrowserViewerMessageSchema", () => {
  it.each([
    { t: "hello", width: 1280, height: 680, state: "waiting" },
    { t: "hello", width: 1280, height: 680, state: "live" },
    { t: "page", url: "https://cal.com", title: "Cal" },
    { t: "state", state: "waiting" },
    { t: "state", state: "live" },
    { t: "state", state: "closed" },
    { t: "state", state: "restarted" },
  ])("accepts %j", (message) => {
    expect(agentBrowserViewerMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    { t: "hello", width: 1280, height: 680, state: "closed" },
    { t: "page", url: "https://cal.com" },
    { t: "state", state: "paused" },
    { t: "frame", data: "AAAA" },
  ])("rejects %j", (message) => {
    expect(agentBrowserViewerMessageSchema.safeParse(message).success).toBe(false);
  });
});
