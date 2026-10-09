import { getNotetakerSessionEventService } from "@calcom/features/notetaker/di/NotetakerSessionEventService.container";
import { getNotetakerConfig } from "@calcom/features/notetaker/lib/config";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  notetakerBotEventSchema,
  verifyNotetakerSignature,
} from "@calcom/lib/notetaker/botContract";
import { defaultResponderForAppDir } from "@calcom/web/app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// defaultResponderForAppDir maps a thrown SyntaxError to 500, so malformed JSON must not throw.
function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

async function postHandler(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();

  const isSignatureValid = verifyNotetakerSignature({
    secret: getNotetakerConfig().botSecret ?? "",
    timestamp: request.headers.get(NOTETAKER_TIMESTAMP_HEADER),
    signature: request.headers.get(NOTETAKER_SIGNATURE_HEADER),
    rawBody,
  });
  if (!isSignatureValid) {
    return NextResponse.json({ message: "Invalid signature" }, { status: 401 });
  }

  const parsed = notetakerBotEventSchema.safeParse(parseJson(rawBody));
  if (!parsed.success) {
    return NextResponse.json({ message: "Invalid event" }, { status: 400 });
  }

  const result = await getNotetakerSessionEventService().handleEvent(parsed.data);
  if (result === "GONE") {
    return NextResponse.json({ message: "Session is gone" }, { status: 410 });
  }

  return NextResponse.json({ ok: true });
}

export const POST = defaultResponderForAppDir(postHandler);
