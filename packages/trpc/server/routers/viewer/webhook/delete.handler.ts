import { updateTriggerForExistingBookings } from "@calcom/features/webhooks/lib/scheduleTrigger";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import type { TDeleteInputSchema } from "./delete.schema";
import { assertTeamAdminForMemberMeetings } from "./memberMeetings";

type DeleteOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TDeleteInputSchema;
};

// Member-meeting webhooks are stored without a userId, so the owner match in deleteHandler never finds them.
const findTeamOwnedWebhook = async ({
  id,
  eventTypeId,
  userId,
}: {
  id: string;
  eventTypeId?: number;
  userId: number;
}) => {
  if (eventTypeId) return null;

  const webhook = await prisma.webhook.findFirst({
    where: { id, userId: null, teamId: { not: null }, eventTypeId: null },
  });
  if (!webhook) return null;

  await assertTeamAdminForMemberMeetings({ userId, teamId: webhook.teamId });
  return webhook;
};

export const deleteHandler = async ({ ctx, input }: DeleteOptions) => {
  const { id } = input;

  const where: Prisma.WebhookWhereInput = { AND: [{ id: id }] };

  if (Array.isArray(where.AND)) {
    if (input.eventTypeId) {
      where.AND.push({ eventTypeId: input.eventTypeId });
    } else if (ctx.user.role === "ADMIN") {
      where.AND.push({ OR: [{ platform: true }, { userId: ctx.user.id }] });
    } else {
      where.AND.push({ userId: ctx.user.id });
    }
  }

  const webhookToDelete =
    (await prisma.webhook.findFirst({
      where,
    })) ?? (await findTeamOwnedWebhook({ id, eventTypeId: input.eventTypeId, userId: ctx.user.id }));

  if (!webhookToDelete) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  await prisma.webhook.delete({
    where: {
      id: webhookToDelete.id,
    },
  });

  await updateTriggerForExistingBookings(webhookToDelete, webhookToDelete.eventTriggers, []);

  return {
    id,
  };
};
