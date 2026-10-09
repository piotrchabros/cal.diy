import { getNotetakerSummaryService } from "@calcom/features/notetaker/di/NotetakerSummaryService.container";
import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TRegenerateSummaryInputSchema } from "./regenerateSummary.schema";

type RegenerateSummaryOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TRegenerateSummaryInputSchema;
};

export const regenerateSummaryHandler = async ({
  ctx,
  input,
}: RegenerateSummaryOptions): Promise<NotetakerSummaryDto> => {
  return getNotetakerSummaryService().requestRegeneration({
    bookingUid: input.bookingUid,
    userId: ctx.user.id,
  });
};
