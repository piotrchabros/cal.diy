import { getNotetakerSharingSettingsService } from "@calcom/features/notetaker/di/NotetakerSharingSettingsService.container";
import type { NotetakerSharingCandidatesDto } from "@calcom/lib/dto/NotetakerEventTypeSharingDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TListEventTypeSharingCandidatesInputSchema } from "./listEventTypeSharingCandidates.schema";

type ListEventTypeSharingCandidatesOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TListEventTypeSharingCandidatesInputSchema;
};

export const listEventTypeSharingCandidatesHandler = async ({
  ctx,
  input,
}: ListEventTypeSharingCandidatesOptions): Promise<NotetakerSharingCandidatesDto> => {
  return getNotetakerSharingSettingsService().listCandidates({
    eventTypeId: input.eventTypeId,
    search: input.search,
    cursor: input.cursor,
    limit: input.limit,
    userId: ctx.user.id,
  });
};
