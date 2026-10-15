import { getNotetakerAdHocService } from "@calcom/features/notetaker/di/NotetakerAdHocService.container";
import type { NotetakerAdHocOptions } from "@calcom/features/notetaker/services/NotetakerAdHocService";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";

type GetAdHocOptionsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
};

export const getAdHocOptionsHandler = async ({
  ctx,
}: GetAdHocOptionsOptions): Promise<NotetakerAdHocOptions> => {
  return getNotetakerAdHocService().getOptions({ userId: ctx.user.id });
};
