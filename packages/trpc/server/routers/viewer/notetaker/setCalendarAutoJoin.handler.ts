import { getNotetakerCalendarAutoJoinSettingsService } from "@calcom/features/notetaker/di/NotetakerCalendarAutoJoinSettingsService.container";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TSetCalendarAutoJoinInputSchema } from "./setCalendarAutoJoin.schema";

type SetCalendarAutoJoinOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TSetCalendarAutoJoinInputSchema;
};

export const setCalendarAutoJoinHandler = async ({
  ctx,
  input,
}: SetCalendarAutoJoinOptions): Promise<void> => {
  await getNotetakerCalendarAutoJoinSettingsService().set({
    userId: ctx.user.id,
    selectedCalendarId: input.selectedCalendarId,
    enabled: input.enabled,
    sharingTeamId: input.sharingTeamId,
  });
};
