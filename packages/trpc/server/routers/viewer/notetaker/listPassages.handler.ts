import { getNotetakerResultsService } from "@calcom/features/notetaker/di/NotetakerResultsService.container";
import type { NotetakerPassageDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TListPassagesInputSchema } from "./listPassages.schema";

type ListPassagesOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TListPassagesInputSchema;
};

export const listPassagesHandler = async ({
  ctx,
  input,
}: ListPassagesOptions): Promise<{ passages: NotetakerPassageDto[]; nextCursor: number | null }> => {
  return getNotetakerResultsService().listPassages({ ...input, userId: ctx.user.id });
};
