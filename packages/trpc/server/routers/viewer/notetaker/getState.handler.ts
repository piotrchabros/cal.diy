import { getNotetakerChoiceService } from "@calcom/features/notetaker/di/NotetakerChoiceService.container";
import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TGetStateInputSchema } from "./getState.schema";

type GetStateOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetStateInputSchema;
};

export const getStateHandler = async ({ ctx, input }: GetStateOptions): Promise<NotetakerStateDto> => {
  return getNotetakerChoiceService().getState({
    bookingUid: input.bookingUid,
    userId: ctx.user.id,
  });
};
