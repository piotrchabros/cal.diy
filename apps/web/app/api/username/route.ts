import { getOrgFromRequest } from "@calcom/features/organizations/lib/getOrgFromRequest";
import { checkUsername } from "@calcom/features/profile/lib/checkUsername";
import { resolveUsernameNamespace } from "@calcom/features/profile/lib/resolveUsernameNamespace";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { defaultResponderForAppDir } from "app/api/defaultResponderForAppDir";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const bodySchema = z.object({
  username: z.string(),
  // Only honoured with organizations disabled; otherwise the org comes from the request host.
  orgSlug: z.string().optional(),
});

async function postHandler(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, orgSlug } = bodySchema.parse(body);

    const orgsEnabled = isOrganizationsEnabled();
    const org = orgsEnabled ? await getOrgFromRequest(await headers()) : null;
    if (orgsEnabled && !org) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const result = await checkUsername(
      username,
      resolveUsernameNamespace({ organizationId: org?.id, legacyOrgSlug: orgSlug })
    );

    return NextResponse.json(result);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to check username availability" }, { status: 400 });
  }
}

export const POST = defaultResponderForAppDir(postHandler);
