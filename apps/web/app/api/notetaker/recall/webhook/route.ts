import { recallWebhookEnvelopeSchema } from "@calcom/features/notetaker/bot/recall/recallSchemas";
import { getRecallWebhookService } from "@calcom/features/notetaker/di/RecallWebhookService.container";
import { getNotetakerConfig } from "@calcom/features/notetaker/lib/config";
import logger from "@calcom/lib/logger";
import { defaultResponderForAppDir } from "@calcom/web/app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { after, NextResponse } from "next/server";
import { parseJson, verifyRecallRequest } from "../recallRequestVerification";

const log = logger.getSubLogger({ prefix: ["notetaker-recall-webhook"] });

async function postHandler(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();

  const recall = getNotetakerConfig().recall;
  if (!recall) {
    return NextResponse.json({ message: "Invalid signature" }, { status: 401 });
  }

  const { valid, webhookId } = verifyRecallRequest(request, rawBody, recall.webhookSecret);
  if (!valid) {
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
