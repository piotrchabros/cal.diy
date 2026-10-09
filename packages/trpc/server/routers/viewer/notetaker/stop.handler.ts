import { getNotetakerChoiceService } from "@calcom/features/notetaker/di/NotetakerChoiceService.container";
import { getNotetakerDispatchService } from "@calcom/features/notetaker/di/NotetakerDispatchService.container";
import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TStopInputSchema } from "./stop.schema";

type StopOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TStopInputSchema;
};

export const stopHandler = async ({ ctx, input }: StopOptions): Promise<NotetakerStateDto> => {
  await getNotetakerDispatchService().stopForBooking({
    bookingUid: input.bookingUid,
    reason: "STOPPED_BY_HOST",
    userId: ctx.user.id,
  });

  // State is read last so it reflects the session stopped above.
  return getNotetakerChoiceService().getState({ bookingUid: input.bookingUid, userId: ctx.user.id });
};
