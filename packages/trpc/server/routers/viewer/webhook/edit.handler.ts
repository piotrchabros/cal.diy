import {
  cancelNoShowTasksForBooking,
  deleteWebhookScheduledTriggers,
  updateTriggerForExistingBookings,
} from "@calcom/features/webhooks/lib/scheduleTrigger";
import { validateUrlForSSRFSync } from "@calcom/lib/ssrfProtection";
import { prisma } from "@calcom/prisma";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import type { TEditInputSchema } from "./edit.schema";
import { assertMemberMeetingsScope, assertTeamAdminForMemberMeetings } from "./memberMeetings";

type EditOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TEditInputSchema;
};

export const editHandler = async ({ input, ctx }: EditOptions) => {
  const { id, webhookId: _webhookId, ...data } = input;

  const webhook = await prisma.webhook.findUnique({
    where: {
      id,
    },
  });

  if (!webhook) {
    return null;
  }

  // SSRF validation: only validate if URL is being changed
  if (data.subscriberUrl && data.subscriberUrl !== webhook.subscriberUrl) {
    const validation = validateUrlForSSRFSync(data.subscriberUrl);
    if (!validation.isValid) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Webhook URL is not allowed: ${validation.error}`,
      });
    }
  }

  if (webhook.platform) {
    const { user } = ctx;
    if (user?.role !== "ADMIN") {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
  }

  if (webhook.includeMemberMeetings) {
    await assertTeamAdminForMemberMeetings({ userId: ctx.user.id, teamId: webhook.teamId });
  }

  const isTeamOwned = webhook.userId == null && webhook.teamId != null && webhook.eventTypeId == null;
  const changesTeam = data.teamId !== undefined && data.teamId !== webhook.teamId;
  const changesEventType = data.eventTypeId !== undefined && data.eventTypeId !== webhook.eventTypeId;
  if (
    (isTeamOwned || (data.includeMemberMeetings ?? webhook.includeMemberMeetings)) &&
    (changesTeam || changesEventType)
  ) {
    // Moving a team-owned webhook would let it escape the team-admin guard or end up ownerless.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The team or event type of a team webhook cannot be changed",
    });
  }

  const enablesMemberMeetings = data.includeMemberMeetings === true && !webhook.includeMemberMeetings;
  if (data.includeMemberMeetings ?? webhook.includeMemberMeetings) {
    const teamId = await assertMemberMeetingsScope({
      teamId: data.teamId ?? webhook.teamId,
      platform: webhook.platform,
      eventTypeId: data.eventTypeId ?? webhook.eventTypeId,
    });
    await assertTeamAdminForMemberMeetings({ userId: ctx.user.id, teamId });
  }

  const updatedWebhook = await prisma.webhook.update({
    where: {
      id,
    },
    data: {
      ...data,
      time: data.time ?? null,
      timeUnit: data.timeUnit ?? null,
      // Turning the flag off again keeps userId null: re-attaching the editing admin would silently make it their personal webhook.
      ...(enablesMemberMeetings ? { userId: null } : {}),
    },
  });

  if (data.active) {
    const activeTriggersBefore = webhook.active ? webhook.eventTriggers : [];
    await updateTriggerForExistingBookings(
      updatedWebhook,
      activeTriggersBefore,
      updatedWebhook.eventTriggers,
      webhook.active ? webhook.includeMemberMeetings : undefined
    );
  } else if (!data.active && webhook.active) {
    await cancelNoShowTasksForBooking({
      webhook: {
        id: webhook.id,
        userId: webhook.userId,
        teamId: webhook.teamId,
        eventTypeId: webhook.eventTypeId,
      },
    });
    await deleteWebhookScheduledTriggers({ webhookId: webhook.id });
  }

  return updatedWebhook;
};
