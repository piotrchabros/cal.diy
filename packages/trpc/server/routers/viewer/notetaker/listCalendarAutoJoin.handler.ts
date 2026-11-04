import { getNotetakerCalendarAutoJoinSettingsService } from "@calcom/features/notetaker/di/NotetakerCalendarAutoJoinSettingsService.container";
import type { NotetakerCalendarAutoJoinSettingsDto } from "@calcom/lib/dto/NotetakerCalendarAutoJoinDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

type ListCalendarAutoJoinOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const listCalendarAutoJoinHandler = async ({
  ctx,
}: ListCalendarAutoJoinOptions): Promise<NotetakerCalendarAutoJoinSettingsDto> => {
  return getNotetakerCalendarAutoJoinSettingsService().list({ userId: ctx.user.id });
};
