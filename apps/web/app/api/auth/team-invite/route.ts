import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import getIP from "@calcom/lib/getIP";
import { piiHasher } from "@calcom/lib/server/PiiHasher";
import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import { parseRequestData } from "app/api/parseRequestData";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const completeTeamInviteSchema = z.object({
  csrfToken: z.string(),
  token: z.string().min(1),
  password: z.string().min(1),
});

async function handler(req: NextRequest) {
  const body = await parseRequestData(req);
  const { csrfToken: submittedToken, token, password } = completeTeamInviteSchema.parse(body);
  const cookieStore = await cookies();

  const cookieToken = cookieStore.get("calcom.csrf_token")?.value;
  if (submittedToken !== cookieToken) {
    return NextResponse.json({ message: "Invalid CSRF token" }, { status: 403 });
  }
  // A resubmit after a failure requires a fresh CSRF token.
  cookieStore.delete("calcom.csrf_token");

  await checkRateLimitAndThrowError({
    rateLimitingType: "core",
    identifier: `api:team-invite:${piiHasher.hash(getIP(req))}`,
  });

  const result = await new TeamMembersService().completeInviteSignup({ token, password });

  return NextResponse.json(result, { status: 201 });
}

export const POST = defaultResponderForAppDir(handler);
