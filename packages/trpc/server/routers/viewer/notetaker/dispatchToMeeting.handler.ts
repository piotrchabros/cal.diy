import { getNotetakerAdHocService } from "@calcom/features/notetaker/di/NotetakerAdHocService.container";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TDispatchToMeetingInputSchema } from "./dispatchToMeeting.schema";

type DispatchToMeetingOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TDispatchToMeetingInputSchema;
};

export const dispatchToMeetingHandler = async ({
  ctx,
  input,
}: DispatchToMeetingOptions): Promise<{ bookingUid: string; reused: boolean }> => {
  await checkRateLimitAndThrowError({
    identifier: `notetaker.dispatchToMeeting:${ctx.user.id}`,
    rateLimitingType: "core",
  });

  const { bookingUid, reused } = await getNotetakerAdHocService().dispatchToMeeting({
    userId: ctx.user.id,
    meetingUrl: input.meetingUrl,
    title: input.title,
    durationMinutes: input.durationMinutes,
    sharingTeamId: input.sharingTeamId,
  });
  return { bookingUid, reused };
};
