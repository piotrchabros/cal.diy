import { getNotetakerResultsService } from "@calcom/features/notetaker/di/NotetakerResultsService.container";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TSetSharingInputSchema } from "./setSharing.schema";

type SetSharingOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TSetSharingInputSchema;
};

export const setSharingHandler = async ({
  ctx,
  input,
}: SetSharingOptions): Promise<{ sharedWithAttendees: boolean }> => {
  return getNotetakerResultsService().setSharing({
    bookingUid: input.bookingUid,
    shared: input.shared,
    userId: ctx.user.id,
  });
};
