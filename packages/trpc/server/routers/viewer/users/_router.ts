import { disableUserRedirectsForReusedUsername } from "@calcom/features/organizations/lib/disableUserRedirectsForReusedUsername";
import { repointUserRedirectsForRename } from "@calcom/features/organizations/lib/repointUserRedirectsForRename";
import { authedAdminProcedure } from "@calcom/trpc/server/procedures/authedProcedure";
import { router } from "@calcom/trpc/server/trpc";
import type { inferRouterOutputs } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { addUserHandler, addUserInputSchema, userBodySchema } from "./add.handler";
import { isImageDataUrl, storeAdminUserAvatar } from "./adminUserAvatar";

export type UserAdminRouter = typeof userAdminRouter;
export type UserAdminRouterOutputs = inferRouterOutputs<UserAdminRouter>;

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
      const data = isImageDataUrl(input.avatarUrl)
        ? { ...input, avatarUrl: await storeAdminUserAvatar(requestedUser.id, input.avatarUrl) }
        : input;

      const user = await prisma.$transaction(async (tx) => {
        const userInternal = await tx.user.update({ where: { id: requestedUser.id }, data });

        // If the profile has been moved to an Org -> we can easily access the profile we need to update
        if (requestedUser.movedToProfileId && input.username) {
          await tx.profile.update({
            where: {
              id: requestedUser.movedToProfileId,
            },
            data: {
              username: input.username,
            },
          });

          return userInternal;
        }

        /**
         * TODO (Sean/Hariom): Change this to profile specific when we have a way for a user to have > 1 orgs
         * If the user wasnt a CAL account before being moved to an org they dont have the movedToProfileId value
         * So we update all of their profiles to this new username - this tx will rollback if there is a username
         * conflict here somehow (Note for now users only have ONE profile.)
         **/
        if (input.username) {
          await tx.profile.updateMany({
            where: {
              userId: requestedUser.id,
            },
            data: {
              username: input.username,
            },
          });
        }

        return userInternal;
      });
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
