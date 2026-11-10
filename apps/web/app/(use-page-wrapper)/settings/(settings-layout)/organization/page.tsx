import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { organizationRouter } from "@calcom/trpc/server/routers/viewer/organization/_router";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import { createRouterCaller } from "app/_trpc/context";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

const Page = async () => {
  if (!isOrganizationsEnabled()) {
    notFound();
  }

  const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
  if (!session?.user?.id) {
    return redirect("/auth/login");
  }

  const caller = await createRouterCaller(organizationRouter);
  try {
    // current() is the membership check: it throws NOT_FOUND unless the viewer is an accepted org member
    await caller.current();
  } catch {
    notFound();
  }

  redirect("/settings/organization/general");
};

export default Page;
