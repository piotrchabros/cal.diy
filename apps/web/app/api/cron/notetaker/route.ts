import process from "node:process";
import { getNotetakerCalendarAutoJoinService } from "@calcom/features/notetaker/di/NotetakerCalendarAutoJoinService.container";
import { getNotetakerDispatchService } from "@calcom/features/notetaker/di/NotetakerDispatchService.container";
import type { NotetakerCalendarPollCounts } from "@calcom/features/notetaker/services/NotetakerCalendarAutoJoinService";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import { defaultResponderForAppDir } from "@calcom/web/app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const log = logger.getSubLogger({ prefix: ["[api]", "[cron/notetaker]"] });

async function getHandler(request: NextRequest) {
  const apiKey = request.headers.get("authorization") || request.nextUrl.searchParams.get("apiKey");

  if (!apiKey) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  // An unset secret must not become a guessable credential such as "Bearer undefined".
  const allowedKeys: string[] = [];
  if (process.env.CRON_API_KEY) allowedKeys.push(process.env.CRON_API_KEY);
  if (process.env.CRON_SECRET) allowedKeys.push(`Bearer ${process.env.CRON_SECRET}`);

  if (!allowedKeys.includes(apiKey)) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  // Dispatch goes first because bots must join on time; the calendar poll can wait for the next tick.
  let dispatchError: unknown = null;
  try {
    await getNotetakerDispatchService().dispatchDue();
  } catch (error) {
    dispatchError = error;
  }

  // A poll failure is logged rather than thrown so it never turns a successful dispatch into a failed run.
  let poll: NotetakerCalendarPollCounts | null = null;
  try {
    poll = await getNotetakerCalendarAutoJoinService().pollDue();
    log.info("Calendar auto-join poll finished", safeStringify(poll));
  } catch (error) {
    log.error("Calendar auto-join poll failed", safeStringify(error));
  }

  if (dispatchError) throw dispatchError;

  return NextResponse.json({ ok: true, poll });
}

export const GET = defaultResponderForAppDir(getHandler);
