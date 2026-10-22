import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import type { NotetakerVideoDownloadResult } from "@calcom/features/notetaker/bot/INotetakerRecordingMediaGateway";
import { getNotetakerResultsService } from "@calcom/features/notetaker/di/NotetakerResultsService.container";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { defaultResponderForAppDir } from "@calcom/web/app/api/defaultResponderForAppDir";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import type { Params } from "app/_types";
import { cookies, headers } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const log = logger.getSubLogger({ prefix: ["notetaker-video-download"] });

const paramsSchema = z.object({ bookingUid: z.string().min(1).max(128) });

// The redirect target is a presigned URL: it must not be cached or leak to the storage host as a referrer.
const PRIVATE_HEADERS = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
};

const NOT_FOUND_CODES = new Set<string>([ErrorCode.NotFound, ErrorCode.Forbidden]);

function json(message: string, status: number): NextResponse {
  return NextResponse.json({ message }, { status, headers: PRIVATE_HEADERS });
}

// Forbidden answers like NotFound so the route does not reveal which bookings have a recording.
function notFound(): NextResponse {
  return json("Video not found", 404);
}

async function getVideoDownload(params: {
  bookingUid: string;
  userId: number;
}): Promise<NotetakerVideoDownloadResult | NextResponse> {
  try {
    return await getNotetakerResultsService().getVideoDownload(params);
  } catch (error) {
    if (error instanceof ErrorWithCode && NOT_FOUND_CODES.has(error.code)) return notFound();
    // Only the kind is logged: messages of provider errors may carry identifiers of the recording.
    let kind = "unknown";
    if (error instanceof ErrorWithCode) kind = error.code;
    else if (error instanceof Error) kind = error.name;
    log.error("Notetaker video lookup failed", { kind });
    return json("The video could not be fetched", 502);
  }
}

async function getHandler(
  _request: NextRequest,
  { params }: { params: Promise<Params> }
): Promise<NextResponse> {
  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
  if (!session?.user?.id) return json("Unauthorized", 401);

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return notFound();

  const result = await getVideoDownload({ bookingUid: parsed.data.bookingUid, userId: session.user.id });
  if (result instanceof NextResponse) return result;

  switch (result.status) {
    case "AVAILABLE":
      return NextResponse.redirect(result.url, { status: 302, headers: PRIVATE_HEADERS });
    case "PROCESSING":
      return json("The video is still being processed", 409);
    case "UNAVAILABLE":
      return notFound();
  }
}

export const GET = defaultResponderForAppDir(getHandler);
