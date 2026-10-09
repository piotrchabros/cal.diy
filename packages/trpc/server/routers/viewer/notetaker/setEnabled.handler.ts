import { getNotetakerChoiceService } from "@calcom/features/notetaker/di/NotetakerChoiceService.container";
import { getNotetakerDispatchService } from "@calcom/features/notetaker/di/NotetakerDispatchService.container";
import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TSetEnabledInputSchema } from "./setEnabled.schema";

type SetEnabledOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TSetEnabledInputSchema;
};

export const setEnabledHandler = async ({ ctx, input }: SetEnabledOptions): Promise<NotetakerStateDto> => {
  const choice = getNotetakerChoiceService();
  const dispatch = getNotetakerDispatchService();

  await choice.setEnabled({ ...input, userId: ctx.user.id });

  if (input.enabled) {
    await dispatch.dispatchForBooking({ bookingUid: input.bookingUid });
  } else {
    await dispatch.stopForBooking({ bookingUid: input.bookingUid, reason: "DISABLED" });
  }

  // State is read last so it reflects the session started or stopped above.
  return choice.getState({ bookingUid: input.bookingUid, userId: ctx.user.id });
};
