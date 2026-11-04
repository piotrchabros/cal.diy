import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { APP_NAME } from "@calcom/lib/constants";
import prisma from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { appsRouter } from "@calcom/trpc/server/routers/viewer/apps/_router";
import { webhookRouter } from "@calcom/trpc/server/routers/viewer/webhook/_router";
import { buildLegacyRequest } from "@lib/buildLegacyCtx";
import { createRouterCaller } from "app/_trpc/context";
import type { PageProps } from "app/_types";
import { _generateMetadata } from "app/_utils";
import { cookies, headers } from "next/headers";
import { NewWebhookView } from "~/webhooks/views/webhook-new-view";

export const generateMetadata = async () =>
  await _generateMetadata(
    (t) => t("webhooks"),
    (t) => t("add_webhook_description", { appName: APP_NAME }),
    undefined,
    undefined,
    "/settings/developer/webhooks/new"
  );

const Page = async ({ searchParams }: PageProps) => {
  const [appsCaller, webhookCaller] = await Promise.all([
    createRouterCaller(appsRouter),
    createRouterCaller(webhookRouter),
  ]);

  const [installedApps, webhooks] = await Promise.all([
    appsCaller.integrations({ variant: "other", onlyInstalled: true }),
    webhookCaller.list(),
  ]);

  const teamIdParam = Number((await searchParams)?.teamId);
  let canManageMemberMeetings: boolean | undefined;
  if (Number.isInteger(teamIdParam) && teamIdParam > 0) {
    const session = await getServerSession({ req: buildLegacyRequest(await headers(), await cookies()) });
    const membership = session?.user?.id
      ? await prisma.membership.findFirst({
          where: { userId: session.user.id, teamId: teamIdParam, accepted: true },
          select: { role: true },
        })
      : null;
    canManageMemberMeetings =
      membership?.role === MembershipRole.ADMIN || membership?.role === MembershipRole.OWNER;
  }

  return (
    <NewWebhookView
      webhooks={webhooks}
      installedApps={installedApps}
      canManageMemberMeetings={canManageMemberMeetings}
    />
  );
};

export default Page;
