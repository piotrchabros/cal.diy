import { getTeamCreationService } from "@calcom/features/teams/di/TeamCreationService.container";
import { ErrorWithCode } from "@calcom/lib/errors";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { getHttpStatusCode } from "@calcom/lib/server/getServerErrorFromUnknown";
import { httpStatusToTrpcCode } from "@calcom/trpc/server/lib/toTRPCError";
import { TRPCError } from "@trpc/server";
import type { TrpcSessionUser } from "../../../types";
import type { TCreateInputSchema } from "./create.schema";

type CreateHandlerOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "organizationId">;
  };
  input: TCreateInputSchema;
};

export const createHandler = async ({ ctx, input }: CreateHandlerOptions) => {
  const organizationId = isOrganizationsEnabled() ? (ctx.user.organizationId ?? null) : null;
  try {
    return await getTeamCreationService().createTeam({
      userId: ctx.user.id,
      name: input.name,
      slug: input.slug,
      bio: input.bio,
      logoUrl: input.logoUrl,
      organizationId,
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
