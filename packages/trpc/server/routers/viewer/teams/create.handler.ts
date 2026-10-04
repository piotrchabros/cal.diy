import { TeamCreationService } from "@calcom/features/teams/services/TeamCreationService";
import { ErrorWithCode } from "@calcom/lib/errors";
import { getHttpStatusCode } from "@calcom/lib/server/getServerErrorFromUnknown";
import { httpStatusToTrpcCode } from "@calcom/trpc/server/lib/toTRPCError";
import type { TrpcSessionUser } from "../../../types";
import { TRPCError } from "@trpc/server";

import type { TCreateInputSchema } from "./create.schema";

type CreateHandlerOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id">;
  };
  input: TCreateInputSchema;
};

export const createHandler = async ({ ctx, input }: CreateHandlerOptions) => {
  try {
    return await TeamCreationService.createTeam({
      userId: ctx.user.id,
      name: input.name,
      slug: input.slug,
      bio: input.bio,
      logoUrl: input.logoUrl,
    });
  } catch (error) {
    if (error instanceof ErrorWithCode) {
      throw new TRPCError({
        code: httpStatusToTrpcCode(getHttpStatusCode(error)),
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
};
