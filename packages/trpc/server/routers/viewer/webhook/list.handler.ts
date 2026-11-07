import { getWebhookFeature } from "@calcom/features/di/webhooks/containers/webhook";
import type { Webhook } from "@calcom/features/webhooks/lib/dto/types";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TListInputSchema } from "./list.schema";
import { assertCanManageEventTypeWebhooks } from "./memberMeetings";

type ListOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TListInputSchema;
};

export const listHandler = async ({ ctx, input }: ListOptions): Promise<Webhook[]> => {
  // listWebhooks does no access check for eventTypeId; repeat it here so the guard does not depend on the procedure alone.
  if (input?.eventTypeId) {
    await assertCanManageEventTypeWebhooks({ userId: ctx.user.id, eventTypeId: input.eventTypeId });
  }

  const { repository } = getWebhookFeature();

  return repository.listWebhooks({
    userId: ctx.user.id,
    appId: input?.appId,
    eventTypeId: input?.eventTypeId,
    eventTriggers: input?.eventTriggers,
  });
};
