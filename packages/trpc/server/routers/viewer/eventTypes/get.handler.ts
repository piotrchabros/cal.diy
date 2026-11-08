import getEventTypeById from "@calcom/features/eventtypes/lib/getEventTypeById";
import type { PrismaClient } from "@calcom/prisma";
import { convertErrorWithCodeToTRPCError } from "@calcom/trpc/server/lib/toTRPCError";
import type { TrpcSessionUser } from "../../../types";
import type { TGetInputSchema } from "./get.schema";

type GetOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TGetInputSchema;
};

export const getHandler = async ({ ctx, input }: GetOptions) => {
  try {
    return await getEventTypeById({
      currentOrganizationId: ctx.user.profile?.organizationId ?? null,
      eventTypeId: input.id,
      userId: ctx.user.id,
      prisma: ctx.prisma,
      isUserOrganizationAdmin: !!ctx.user?.organization?.isOrgAdmin,
      userLocale: ctx.user.locale,
    });
  } catch (error) {
    throw convertErrorWithCodeToTRPCError(error);
  }
};
