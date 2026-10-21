// Recall signs webhooks with the Svix scheme: https://docs.recall.ai/docs/authenticating-requests-from-recallai
import { createHmac, timingSafeEqual } from "node:crypto";

export const RECALL_WEBHOOK_ID_HEADER = "webhook-id";
export const RECALL_WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const RECALL_WEBHOOK_SIGNATURE_HEADER = "webhook-signature";
export const RECALL_WEBHOOK_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1";
const TIMESTAMP_PATTERN = /^\d+$/;

function decodeSecret(secret: string): Buffer | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), "base64");
  return key.length > 0 ? key : null;
}

function computeSignature(key: Buffer, webhookId: string, timestamp: string, rawBody: string): Buffer {
  return createHmac("sha256", key).update(`${webhookId}.${timestamp}.${rawBody}`).digest();
}

export function signRecallWebhookPayload(input: {
  secret: string;
  webhookId: string;
  timestamp: string | number;
  rawBody: string;
}): string {
  const key = decodeSecret(input.secret);
  if (!key) throw new Error("Recall webhook secret must be a non-empty whsec_ base64 value");
  const signature = computeSignature(key, input.webhookId, String(input.timestamp), input.rawBody);
  return `${SIGNATURE_VERSION},${signature.toString("base64")}`;
}

export function verifyRecallWebhookSignature(input: {
  secret: string;
  webhookId?: string | null;
  timestamp?: string | null;
  signatureHeader?: string | null;
  rawBody: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const { webhookId, timestamp, signatureHeader } = input;
  if (!webhookId || !timestamp || !signatureHeader) return false;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return false;

  const key = decodeSecret(input.secret);
  if (!key) return false;

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = input.toleranceSeconds ?? RECALL_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;

  const expected = computeSignature(key, webhookId, timestamp, input.rawBody);

  for (const entry of signatureHeader.split(" ")) {
    const commaIndex = entry.indexOf(",");
    if (commaIndex === -1) continue;
    if (entry.slice(0, commaIndex) !== SIGNATURE_VERSION) continue;
    const candidate = Buffer.from(entry.slice(commaIndex + 1), "base64");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}
