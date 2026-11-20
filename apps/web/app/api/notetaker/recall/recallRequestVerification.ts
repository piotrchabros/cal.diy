import {
  RECALL_WEBHOOK_ID_HEADER,
  RECALL_WEBHOOK_SIGNATURE_HEADER,
  RECALL_WEBHOOK_TIMESTAMP_HEADER,
  verifyRecallWebhookSignature,
} from "@calcom/lib/notetaker/recallWebhookSignature";
import type { NextRequest } from "next/server";

// defaultResponderForAppDir maps a thrown SyntaxError to 500, so malformed JSON must not throw.
export function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

// Recall delivers through Svix, which may still send the legacy svix-* header names.
export function getHeader(request: NextRequest, name: string, fallbackName: string): string | null {
  return request.headers.get(name) ?? request.headers.get(fallbackName);
}

export function verifyRecallRequest(
  request: NextRequest,
  rawBody: string,
  secret: string
): { valid: boolean; webhookId: string | null } {
  const webhookId = getHeader(request, RECALL_WEBHOOK_ID_HEADER, "svix-id");
  const valid = verifyRecallWebhookSignature({
    secret,
    webhookId,
    timestamp: getHeader(request, RECALL_WEBHOOK_TIMESTAMP_HEADER, "svix-timestamp"),
    signatureHeader: getHeader(request, RECALL_WEBHOOK_SIGNATURE_HEADER, "svix-signature"),
    rawBody,
  });
  return { valid, webhookId };
}
