import { getNotetakerSharingSettingsService } from "@calcom/features/notetaker/di/NotetakerSharingSettingsService.container";
import type { NotetakerEventTypeSharingDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TGetEventTypeSharingInputSchema } from "./getEventTypeSharing.schema";

type GetEventTypeSharingOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetEventTypeSharingInputSchema;
};

export const getEventTypeSharingHandler = async ({
  ctx,
  input,
}: GetEventTypeSharingOptions): Promise<NotetakerEventTypeSharingDto> => {
  return getNotetakerSharingSettingsService().get({
    eventTypeId: input.eventTypeId,
    userId: ctx.user.id,
  });
};
