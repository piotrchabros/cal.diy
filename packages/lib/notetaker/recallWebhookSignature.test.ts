import { describe, expect, it } from "vitest";
import {
  RECALL_WEBHOOK_TOLERANCE_SECONDS,
  signRecallWebhookPayload,
  verifyRecallWebhookSignature,
} from "./recallWebhookSignature";

const SECRET = `whsec_${Buffer.from("recall-test-signing-key").toString("base64")}`;
const NOW = 1893492000;
const WEBHOOK_ID = "msg_2abc";
const RAW_BODY = JSON.stringify({ event: "bot.done", data: { bot: { id: "bot-1" } } });

function sign(overrides: { timestamp?: number; webhookId?: string; rawBody?: string } = {}) {
  return signRecallWebhookPayload({
    secret: SECRET,
    webhookId: overrides.webhookId ?? WEBHOOK_ID,
    timestamp: overrides.timestamp ?? NOW,
    rawBody: overrides.rawBody ?? RAW_BODY,
  });
}

function verify(overrides: Partial<Parameters<typeof verifyRecallWebhookSignature>[0]> = {}) {
  return verifyRecallWebhookSignature({
    secret: SECRET,
    webhookId: WEBHOOK_ID,
    timestamp: String(NOW),
    signatureHeader: sign(),
    rawBody: RAW_BODY,
    nowSeconds: NOW,
    ...overrides,
  });
}

describe("recall webhook signature", () => {
  it("signs as v1,<base64>", () => {
    expect(sign()).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
  });

  it("accepts a signed payload", () => {
    expect(verify()).toBe(true);
  });

  it("accepts when a later signature in the header is the valid one", () => {
    expect(verify({ signatureHeader: `v1,${Buffer.from("nope").toString("base64")} ${sign()}` })).toBe(true);
  });

  it("ignores non-v1 signatures", () => {
    const [, signature] = sign().split(",");
    expect(verify({ signatureHeader: `v2,${signature}` })).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verify({ rawBody: `${RAW_BODY} ` })).toBe(false);
  });

  it("rejects a different webhook id", () => {
    expect(verify({ webhookId: "msg_other" })).toBe(false);
  });

  it("rejects a stale or future timestamp but accepts one at the tolerance edge", () => {
    const stale = NOW - RECALL_WEBHOOK_TOLERANCE_SECONDS - 1;
    const future = NOW + RECALL_WEBHOOK_TOLERANCE_SECONDS + 1;
    const edge = NOW - RECALL_WEBHOOK_TOLERANCE_SECONDS;
    expect(verify({ timestamp: String(stale), signatureHeader: sign({ timestamp: stale }) })).toBe(false);
    expect(verify({ timestamp: String(future), signatureHeader: sign({ timestamp: future }) })).toBe(false);
    expect(verify({ timestamp: String(edge), signatureHeader: sign({ timestamp: edge }) })).toBe(true);
  });

  it("rejects missing headers", () => {
    expect(verify({ webhookId: null })).toBe(false);
    expect(verify({ timestamp: undefined })).toBe(false);
    expect(verify({ signatureHeader: "" })).toBe(false);
    expect(verify({ signatureHeader: null })).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verify({ timestamp: "12abc" })).toBe(false);
    expect(verify({ timestamp: "-5" })).toBe(false);
  });

  it("rejects empty, unprefixed or empty-key secrets", () => {
    expect(verify({ secret: "" })).toBe(false);
    expect(verify({ secret: Buffer.from("recall-test-signing-key").toString("base64") })).toBe(false);
    expect(verify({ secret: "whsec_" })).toBe(false);
  });

  it("rejects a signature signed with another secret", () => {
    const other = `whsec_${Buffer.from("another-key").toString("base64")}`;
    expect(verify({ secret: other })).toBe(false);
  });

  it("does not throw on malformed signature entries", () => {
    for (const header of ["v1", "v1,", ",", "v1,!!!not-base64!!!", "   ", "garbage v1,%%%"]) {
      expect(verify({ signatureHeader: header })).toBe(false);
    }
  });
});
