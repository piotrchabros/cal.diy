import { getNotetakerResultsService } from "@calcom/features/notetaker/di/NotetakerResultsService.container";
import type { NotetakerExportDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TExportInputSchema } from "./export.schema";

type ExportOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TExportInputSchema;
};

export const exportHandler = async ({ ctx, input }: ExportOptions): Promise<NotetakerExportDto> => {
  return getNotetakerResultsService().export({
    bookingUid: input.bookingUid,
    format: input.format,
    userId: ctx.user.id,
  });
};
