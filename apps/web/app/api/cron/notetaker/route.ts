import process from "node:process";
import { getNotetakerDispatchService } from "@calcom/features/notetaker/di/NotetakerDispatchService.container";
import { defaultResponderForAppDir } from "@calcom/web/app/api/defaultResponderForAppDir";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

async function getHandler(request: NextRequest) {
  const apiKey = request.headers.get("authorization") || request.nextUrl.searchParams.get("apiKey");

  if (![process.env.CRON_API_KEY, `Bearer ${process.env.CRON_SECRET}`].includes(`${apiKey}`)) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  await getNotetakerDispatchService().dispatchDue();

  return NextResponse.json({ ok: true });
}

export const GET = defaultResponderForAppDir(getHandler);
