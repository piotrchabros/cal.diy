// Shared with apps/agent-browser, which has no access to the rest of the monorepo's packages:
// keep the imports of this file to `zod` and Node's `crypto`.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// The viewer adds a 40px address bar on top, which makes the shared screen exactly 1280x720.
export const AGENT_BROWSER_VIEWPORT = { width: 1280, height: 680 } as const;
export const AGENT_BROWSER_SNAPSHOT_MAX_CHARS = 6000;
export const AGENT_BROWSER_MAX_URL_LENGTH = 2048;
export const AGENT_BROWSER_MAX_TYPE_LENGTH = 500;
export const AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS = 21_600;
export const AGENT_BROWSER_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
] as const;

const TOKEN_VERSION = "v1";
const TOKEN_CLOCK_SKEW_SECONDS = 60;
const TOKEN_SECONDS_PATTERN = /^\d{1,12}$/;
// base64url of a 32-byte HMAC-SHA256 digest, unpadded.
const TOKEN_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BEARER_PREFIX = "Bearer ";

// Dots are excluded because they separate the fields of a viewer token.
export const agentBrowserBotIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const refSchema = z.string().regex(/^e\d{1,5}$/);

export const agentBrowserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("goto"), url: z.string().min(1).max(AGENT_BROWSER_MAX_URL_LENGTH) }),
  z.object({ type: z.literal("snapshot") }),
  z.object({ type: z.literal("click"), ref: refSchema }),
  z.object({ type: z.literal("click_text"), text: z.string().trim().min(1).max(200) }),
  z.object({
    type: z.literal("type"),
    ref: refSchema,
    text: z.string().max(AGENT_BROWSER_MAX_TYPE_LENGTH),
    submit: z.boolean(),
  }),
  z.object({ type: z.literal("press"), key: z.enum(AGENT_BROWSER_KEYS) }),
  z.object({
    type: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.enum(["page", "half"]),
  }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("screenshot") }),
]);

export type AgentBrowserAction = z.infer<typeof agentBrowserActionSchema>;

export const agentBrowserPageStateSchema = z.object({
  // True when this call created the session, so the caller knows the viewer may need sharing.
  created: z.boolean(),
  url: z.string(),
  title: z.string().max(300),
  // Room for the truncation marker appended after the capped snapshot body.
  snapshot: z.string().max(AGENT_BROWSER_SNAPSHOT_MAX_CHARS + 200),
  viewers: z.number().int().min(0),
  screenshot: z.object({ mediaType: z.literal("image/jpeg"), base64: z.string() }).nullable(),
});

export type AgentBrowserPageState = z.infer<typeof agentBrowserPageStateSchema>;

export const AGENT_BROWSER_ERROR_CODES = [
  "UNAUTHORIZED",
  "INVALID_INPUT",
  "SESSION_NOT_FOUND",
  "CAPACITY",
  "BLOCKED_URL",
  "STALE_REF",
  "ACTION_FAILED",
  "TIMEOUT",
  "INTERNAL",
] as const;

export type AgentBrowserErrorCode = (typeof AGENT_BROWSER_ERROR_CODES)[number];

export const agentBrowserErrorResponseSchema = z.object({
  error: z.enum(AGENT_BROWSER_ERROR_CODES),
  message: z.string().max(300),
});

export const agentBrowserHealthSchema = z.object({
  ok: z.literal(true),
  sessions: z.number(),
  maxSessions: z.number(),
  viewers: z.number(),
  version: z.string(),
});

export const agentBrowserViewerMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    width: z.number(),
    height: z.number(),
    state: z.enum(["waiting", "live"]),
  }),
  z.object({ t: z.literal("page"), url: z.string(), title: z.string() }),
  z.object({ t: z.literal("state"), state: z.enum(["waiting", "live", "closed", "restarted"]) }),
]);

export type AgentBrowserViewerMessage = z.infer<typeof agentBrowserViewerMessageSchema>;

// Separate derived keys keep a leaked viewer token from ever helping to forge the internal API credential.
export function deriveAgentBrowserKey(secret: string, purpose: "internal-api" | "viewer-token"): Buffer {
  return createHmac("sha256", secret).update(`agent-browser/${purpose}/v1`).digest();
}

export function buildAgentBrowserAuthorization(secret: string): string {
  return `${BEARER_PREFIX}${deriveAgentBrowserKey(secret, "internal-api").toString("hex")}`;
}

export function verifyAgentBrowserAuthorization(secret: string, header: string | null | undefined): boolean {
  // An unset secret must never authenticate anything, even a header derived from the empty string.
  if (!secret || !header) return false;

  const expected = Buffer.from(buildAgentBrowserAuthorization(secret));
  const actual = Buffer.from(header);
  // timingSafeEqual throws on unequal lengths; the expected length is fixed, so this leaks nothing secret.
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}

function signViewerTokenPayload(secret: string, payload: string): string {
  return createHmac("sha256", deriveAgentBrowserKey(secret, "viewer-token"))
    .update(payload)
    .digest("base64url");
}

export function signAgentBrowserViewerToken(input: {
  secret: string;
  botId: string;
  issuedAt: Date;
  ttlSeconds: number;
}): string {
  if (!agentBrowserBotIdSchema.safeParse(input.botId).success) {
    throw new Error(`Cannot sign agent browser viewer token: invalid botId "${input.botId}"`);
  }
  if (
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds <= 0 ||
    input.ttlSeconds > AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS
  ) {
    throw new Error(
      `Cannot sign agent browser viewer token: ttlSeconds ${input.ttlSeconds} must be an integer in 1..${AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS}`
    );
  }

  const issuedAtSeconds = Math.floor(input.issuedAt.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + input.ttlSeconds;
  const payload = `${TOKEN_VERSION}.${input.botId}.${issuedAtSeconds}.${expiresAtSeconds}`;

  return `${payload}.${signViewerTokenPayload(input.secret, payload)}`;
}

export function verifyAgentBrowserViewerToken(input: {
  secret: string;
  token: string;
  now: Date;
}): { botId: string; issuedAt: Date; expiresAt: Date } | null {
  if (!input.secret) return null;

  const parts = input.token.split(".");
  if (parts.length !== 5) return null;
  const [version, botId, issuedAtRaw, expiresAtRaw, signature] = parts;

  if (version !== TOKEN_VERSION) return null;
  if (!agentBrowserBotIdSchema.safeParse(botId).success) return null;
  if (!TOKEN_SECONDS_PATTERN.test(issuedAtRaw) || !TOKEN_SECONDS_PATTERN.test(expiresAtRaw)) return null;
  if (!TOKEN_SIGNATURE_PATTERN.test(signature)) return null;

  const issuedAtSeconds = Number(issuedAtRaw);
  const expiresAtSeconds = Number(expiresAtRaw);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);

  if (expiresAtSeconds <= nowSeconds) return null;
  if (expiresAtSeconds <= issuedAtSeconds) return null;
  if (expiresAtSeconds - issuedAtSeconds > AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS) return null;
  if (issuedAtSeconds > nowSeconds + TOKEN_CLOCK_SKEW_SECONDS) return null;

  const expected = signViewerTokenPayload(input.secret, `${version}.${botId}.${issuedAtRaw}.${expiresAtRaw}`);
  // TOKEN_SIGNATURE_PATTERN fixes the length, which timingSafeEqual requires to be equal on both sides.
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  return {
    botId,
    issuedAt: new Date(issuedAtSeconds * 1000),
    expiresAt: new Date(expiresAtSeconds * 1000),
  };
}
