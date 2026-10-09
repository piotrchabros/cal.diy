import process from "node:process";
import { getNotetakerDispatchService } from "@calcom/features/notetaker/di/NotetakerDispatchService.container";
import { defaultResponderForAppDir } from "@calcom/web/app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

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

  await getNotetakerDispatchService().dispatchDue();

  return NextResponse.json({ ok: true });
}

export const GET = defaultResponderForAppDir(getHandler);
