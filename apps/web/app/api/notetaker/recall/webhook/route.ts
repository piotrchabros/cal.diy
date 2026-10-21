import { recallWebhookEnvelopeSchema } from "@calcom/features/notetaker/bot/recall/recallSchemas";
import { getRecallWebhookService } from "@calcom/features/notetaker/di/RecallWebhookService.container";
import { getNotetakerConfig } from "@calcom/features/notetaker/lib/config";
import logger from "@calcom/lib/logger";
import {
  RECALL_WEBHOOK_ID_HEADER,
  RECALL_WEBHOOK_SIGNATURE_HEADER,
  RECALL_WEBHOOK_TIMESTAMP_HEADER,
  verifyRecallWebhookSignature,
} from "@calcom/lib/notetaker/recallWebhookSignature";
import { defaultResponderForAppDir } from "@calcom/web/app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { after, NextResponse } from "next/server";

const log = logger.getSubLogger({ prefix: ["notetaker-recall-webhook"] });

// defaultResponderForAppDir maps a thrown SyntaxError to 500, so malformed JSON must not throw.
function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

// Recall delivers through Svix, which may still send the legacy svix-* header names.
function getHeader(request: NextRequest, name: string, fallbackName: string): string | null {
  return request.headers.get(name) ?? request.headers.get(fallbackName);
}

async function postHandler(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();

  const recall = getNotetakerConfig().recall;
  if (!recall) {
    return NextResponse.json({ message: "Invalid signature" }, { status: 401 });
  }

  const webhookId = getHeader(request, RECALL_WEBHOOK_ID_HEADER, "svix-id");
  const isSignatureValid = verifyRecallWebhookSignature({
    secret: recall.webhookSecret,
    webhookId,
    timestamp: getHeader(request, RECALL_WEBHOOK_TIMESTAMP_HEADER, "svix-timestamp"),
    signatureHeader: getHeader(request, RECALL_WEBHOOK_SIGNATURE_HEADER, "svix-signature"),
    rawBody,
  });
  if (!isSignatureValid) {
    log.warn("Rejected Recall webhook with an invalid signature", {
      webhookId,
      bodyLength: rawBody.length,
    });
    return NextResponse.json({ message: "Invalid signature" }, { status: 401 });
  }

  // Recall retries non-2xx responses, and a payload we cannot parse will not parse on retry either.
  const parsed = recallWebhookEnvelopeSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) {
    log.warn("Ignored Recall webhook with an unexpected payload shape", { webhookId });
    return NextResponse.json({ ok: true });
  }

  const envelope = parsed.data;
  // Processing calls the Recall API and may download a transcript, which would outlast Recall's
  // delivery timeout; the webhook is only a trigger, so acknowledge first and sync afterwards. Because
  // Recall will not redeliver after a 200, transient failures are retried in-process.
  after(async () => {
    try {
      await getRecallWebhookService().processWithRetry(envelope);
    } catch (error) {
      log.error("Failed to process Recall webhook", {
        event: envelope.event,
        botId: envelope.data.bot?.id ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return NextResponse.json({ ok: true });
}

export const POST = defaultResponderForAppDir(postHandler);
