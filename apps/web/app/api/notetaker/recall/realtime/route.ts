import { recallRealtimeEnvelopeSchema } from "@calcom/features/notetaker/bot/recall/recallSchemas";
import { getRecallRealtimeEventService } from "@calcom/features/notetaker/di/RecallRealtimeEventService.container";
import { getNotetakerConfig, isNotetakerAgentUsable } from "@calcom/features/notetaker/lib/config";
import logger from "@calcom/lib/logger";
import { defaultResponderForAppDir } from "@calcom/web/app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { after, NextResponse } from "next/server";
import { parseJson, verifyRecallRequest } from "../recallRequestVerification";

const log = logger.getSubLogger({ prefix: ["notetaker-recall-realtime"] });

async function postHandler(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();

  const config = getNotetakerConfig();
  const recall = config.recall;
  if (!recall) {
    return NextResponse.json({ message: "Invalid signature" }, { status: 401 });
  }

  const { valid, webhookId } = verifyRecallRequest(request, rawBody, recall.webhookSecret);
  if (!valid) {
    log.warn("Rejected Recall realtime event with an invalid signature", {
      webhookId,
      bodyLength: rawBody.length,
    });
    return NextResponse.json({ message: "Invalid signature" }, { status: 401 });
  }

  // A non-2xx makes Recall retry every second up to 60 times and then mark the realtime endpoint
  // failed for the rest of the meeting, so a disabled agent still acknowledges.
  if (!isNotetakerAgentUsable(config)) {
    return NextResponse.json({ ok: true });
  }

  const parsed = recallRealtimeEnvelopeSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) {
    log.warn("Ignored Recall realtime event with an unexpected payload shape", { webhookId });
    return NextResponse.json({ ok: true });
  }

  const envelope = parsed.data;
  // Recall sends realtime events serially, so blocking here would delay every later utterance, and an
  // agent run can take tens of seconds.
  after(async () => {
    try {
      await getRecallRealtimeEventService().handle(envelope, webhookId);
    } catch (error) {
      log.error("Failed to process Recall realtime event", {
        event: envelope.event,
        botId: envelope.data.bot.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return NextResponse.json({ ok: true });
}

export const POST = defaultResponderForAppDir(postHandler);
