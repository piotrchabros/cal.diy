import { getNotetakerSharingSettingsService } from "@calcom/features/notetaker/di/NotetakerSharingSettingsService.container";
import type { NotetakerEventTypeSharingDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TSetEventTypeSharingInputSchema } from "./setEventTypeSharing.schema";

type SetEventTypeSharingOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TSetEventTypeSharingInputSchema;
};

export const setEventTypeSharingHandler = async ({
  ctx,
  input,
}: SetEventTypeSharingOptions): Promise<NotetakerEventTypeSharingDto> => {
  return getNotetakerSharingSettingsService().set({
    eventTypeId: input.eventTypeId,
    mode: input.mode,
    userIds: input.userIds,
    userId: ctx.user.id,
  });
};
