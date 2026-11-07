import { getOrganizationMembershipService } from "@calcom/features/organizations/di/OrganizationMembershipService.container";
import { disableUserRedirectsForReusedUsername } from "@calcom/features/organizations/lib/disableUserRedirectsForReusedUsername";
import { repointUserRedirectsForRename } from "@calcom/features/organizations/lib/repointUserRedirectsForRename";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { authedAdminProcedure } from "@calcom/trpc/server/procedures/authedProcedure";
import { router } from "@calcom/trpc/server/trpc";
import type { inferRouterOutputs } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { addUserHandler, addUserInputSchema, userBodySchema } from "./add.handler";
import { isImageDataUrl, storeAdminUserAvatar } from "./adminUserAvatar";

export type UserAdminRouter = typeof userAdminRouter;
export type UserAdminRouterOutputs = inferRouterOutputs<UserAdminRouter>;

const changeUsernameOrThrow = async (userId: number, username: string): Promise<void> => {
  try {
    await getOrganizationMembershipService().changeUsername({ userId, username });
  } catch (error) {
    if (error instanceof ErrorWithCode && error.code === ErrorCode.Conflict) {
      throw new TRPCError({ code: "CONFLICT", message: error.message });
    }
    throw error;
  }
};

const userIdSchema = z.object({ userId: z.coerce.number() });

/** Reusable logic that checks for admin permissions and if the requested user exists */
//const authedAdminWithUserMiddleware = middleware();

const authedAdminProcedureWithRequestedUser = authedAdminProcedure.use(async ({ ctx, next, getRawInput }) => {
  const { prisma } = ctx;
  const parsed = userIdSchema.safeParse(await getRawInput());
  if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: "User id is required" });
  const { userId: id } = parsed.data;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
  return next({
    ctx: {
      user: ctx.user,
      requestedUser: user,
    },
  });
});

export const userAdminRouter = router({
  get: authedAdminProcedureWithRequestedUser.input(userIdSchema).query(async ({ ctx }) => {
    const { requestedUser } = ctx;
    return { user: requestedUser };
  }),
  list: authedAdminProcedure.query(async ({ ctx }) => {
    const { prisma } = ctx;
    // TODO: Add search, pagination, etc.
    const users = await prisma.user.findMany();
    return users;
  }),
  add: authedAdminProcedure.input(addUserInputSchema).mutation(addUserHandler),
  update: authedAdminProcedureWithRequestedUser
    .input(userBodySchema.partial())
    .mutation(async ({ ctx, input }) => {
      const { prisma, requestedUser } = ctx;
      const { username, ...rest } = input;
      const fields = username === null ? { ...rest, username } : rest;
      const data = isImageDataUrl(fields.avatarUrl)
        ? { ...fields, avatarUrl: await storeAdminUserAvatar(requestedUser.id, fields.avatarUrl) }
        : fields;

      // Written before any other change so a username conflict aborts the whole update. Called even for an
      // unchanged username so an accepted org member missing their org profile gets it (T220).
      if (username) await changeUsernameOrThrow(requestedUser.id, username);

      const user = await prisma.user.update({ where: { id: requestedUser.id }, data });
      if (input.username && input.username !== requestedUser.username) {
        await repointUserRedirectsForRename({
          organizationId: requestedUser.organizationId,
          oldUsername: requestedUser.username,
          newUsername: input.username,
        });
        await disableUserRedirectsForReusedUsername({
          organizationId: requestedUser.organizationId,
          username: input.username,
        });
      }
      return { user, message: `User with id: ${user.id} updated successfully` };
    }),
  delete: authedAdminProcedureWithRequestedUser.input(userIdSchema).mutation(async ({ ctx }) => {
    const { prisma, requestedUser } = ctx;
    await prisma.user.delete({ where: { id: requestedUser.id } });
    return { message: `User with id: ${requestedUser.id} deleted successfully` };
  }),
});
