import { getNotetakerSharedResultsService } from "@calcom/features/notetaker/di/NotetakerSharedResultsService.container";
import type { NotetakerSharedResultsDto } from "@calcom/lib/dto/NotetakerSharedResultDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TListSharedWithMeInputSchema } from "./listSharedWithMe.schema";

type ListSharedWithMeOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TListSharedWithMeInputSchema;
};

export const listSharedWithMeHandler = async ({
  ctx,
  input,
}: ListSharedWithMeOptions): Promise<NotetakerSharedResultsDto> => {
  return getNotetakerSharedResultsService().list({
    userId: ctx.user.id,
    cursor: input.cursor,
    limit: input.limit,
  });
};
