import { updateTriggerForExistingBookings } from "@calcom/features/webhooks/lib/scheduleTrigger";
import { validateUrlForSSRFSync } from "@calcom/lib/ssrfProtection";
import { prisma } from "@calcom/prisma";
import type { Prisma, Webhook } from "@calcom/prisma/client";
import { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import { v4 } from "uuid";
import type { TCreateInputSchema } from "./create.schema";
import { assertMemberMeetingsScope, assertTeamAdminForMemberMeetings } from "./memberMeetings";

type CreateOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TCreateInputSchema;
};

export const createHandler = async ({ ctx, input }: CreateOptions) => {
  const { user } = ctx;

  const validation = validateUrlForSSRFSync(input.subscriberUrl);
  if (!validation.isValid) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Webhook URL is not allowed: ${validation.error}`,
    });
  }

  const { webhookId: _webhookId, ...inputWithoutWebhookId } = input;
  const webhookData: Prisma.WebhookCreateInput = {
    id: v4(),
    ...inputWithoutWebhookId,
  };
  if (input.platform && user.role !== "ADMIN") {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  if (input.includeMemberMeetings) {
    const teamId = await assertMemberMeetingsScope(input);
    await assertTeamAdminForMemberMeetings({ userId: user.id, teamId });
  }

  // Member-meeting webhooks belong to the team, not their creator, so they keep firing if the creator leaves.
  if (!input.platform && !input.eventTypeId && !input.includeMemberMeetings) {
    webhookData.user = { connect: { id: user.id } };
  }

  if (input.eventTypeId) {
    const parentManagedEvt = await prisma.eventType.findFirst({
      where: {
        id: input.eventTypeId,
        parentId: {
          not: null,
        },
      },
      select: {
        parentId: true,
        metadata: true,
      },
    });

    if (parentManagedEvt?.parentId) {
      const isLocked = !EventTypeMetaDataSchema.parse(parentManagedEvt.metadata)?.managedEventConfig
        ?.unlockedFields?.webhooks;
      if (isLocked) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
    }
  }

  let newWebhook: Webhook;
  try {
    newWebhook = await prisma.webhook.create({
      data: webhookData,
    });
  } catch (error) {
    // Avoid printing raw prisma error on frontend
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create webhook" });
  }

  await updateTriggerForExistingBookings(newWebhook, [], newWebhook.eventTriggers);

  return newWebhook;
};
