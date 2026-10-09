import { getNotetakerChoiceService } from "@calcom/features/notetaker/di/NotetakerChoiceService.container";
import { getNotetakerResultsService } from "@calcom/features/notetaker/di/NotetakerResultsService.container";
import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TDeleteResultsInputSchema } from "./deleteResults.schema";

type DeleteResultsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TDeleteResultsInputSchema;
};

export const deleteResultsHandler = async ({
  ctx,
  input,
}: DeleteResultsOptions): Promise<NotetakerStateDto> => {
  await getNotetakerResultsService().deleteResults({ bookingUid: input.bookingUid, userId: ctx.user.id });

  // State is read last so it reflects the results deleted above.
  return getNotetakerChoiceService().getState({ bookingUid: input.bookingUid, userId: ctx.user.id });
};
