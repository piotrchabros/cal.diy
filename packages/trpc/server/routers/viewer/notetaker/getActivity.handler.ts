import { getNotetakerResultsService } from "@calcom/features/notetaker/di/NotetakerResultsService.container";
import type { NotetakerActivityDto } from "@calcom/lib/dto/NotetakerActivityDto";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TGetActivityInputSchema } from "./getActivity.schema";

type GetActivityOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TGetActivityInputSchema;
};

export const getActivityHandler = async ({
  ctx,
  input,
}: GetActivityOptions): Promise<NotetakerActivityDto[]> => {
  return getNotetakerResultsService().getActivity({ bookingUid: input.bookingUid, userId: ctx.user.id });
};
