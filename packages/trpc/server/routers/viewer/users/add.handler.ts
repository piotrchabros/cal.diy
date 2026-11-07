import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { CreationSource } from "@calcom/prisma/enums";
import { UserSchema } from "@calcom/prisma/zod/modelSchema/UserSchema";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { convertErrorWithCodeToTRPCError } from "../../../lib/toTRPCError";
import { isImageDataUrl, storeAdminUserAvatar } from "./adminUserAvatar";

export const userBodySchema = UserSchema.pick({
  name: true,
  email: true,
  username: true,
  bio: true,
  timeZone: true,
  weekStart: true,
  theme: true,
  defaultScheduleId: true,
  locale: true,
  timeFormat: true,
  // brandColor: true,
  // darkBrandColor: true,
  allowDynamicBooking: true,
  identityProvider: true,
  role: true,
  avatarUrl: true,
});

export const addUserInputSchema = userBodySchema.extend({
  organizationId: z.number().int().positive().optional(),
});

export type TAddUserInput = z.infer<typeof addUserInputSchema>;

type AddUserOptions = {
  ctx: {
    prisma: PrismaClient;
  };
  input: TAddUserInput;
};

const resolveOrganizationId = async (requestedId: number | undefined): Promise<number> => {
  const { getOrganizationService } = await import(
    "@calcom/features/organizations/di/OrganizationService.container"
  );
  const organizationService = getOrganizationService();
  const organization = requestedId
    ? await organizationService.get(requestedId)
    : await organizationService.getDefault();
  return organization.id;
};

const createOrganizationUser = async (
  prisma: PrismaClient,
  data: Omit<TAddUserInput, "organizationId" | "avatarUrl"> & { avatarUrl: string | null | undefined },
  requestedOrganizationId: number | undefined
) => {
  // Org profiles are keyed by username, so membership cannot be created without one
  if (!data.username) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Username is required to add a user to an organization",
    });
  }

  try {
    const organizationId = await resolveOrganizationId(requestedOrganizationId);

    const created = await prisma.user
      .create({ data: { ...data, organizationId, creationSource: CreationSource.WEBAPP } })
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A user with this email or username already exists in this organization",
          });
        }
        throw e;
      });

    const { getOrganizationMembershipService } = await import(
      "@calcom/features/organizations/di/OrganizationMembershipService.container"
    );
    try {
      await getOrganizationMembershipService().addMember({
        organizationId,
        userId: created.id,
        role: "MEMBER",
      });
    } catch (e) {
      // User creation and membership run in separate transactions, so undo the user to avoid a half-joined org member
      await prisma.user.delete({ where: { id: created.id }, select: { id: true } });
      throw e;
    }
    return created;
  } catch (e) {
    // tRPC v11 hands resolver errors back as a failed result, so errorConversionMiddleware never sees them
    throw convertErrorWithCodeToTRPCError(e);
  }
};

const createUserWithOrganizationsDisabled = async (
  prisma: PrismaClient,
  data: Omit<TAddUserInput, "organizationId" | "avatarUrl"> & { avatarUrl: string | null | undefined }
) => {
  const { findDefaultOrganizationId } = await import(
    "@calcom/features/organizations/lib/defaultOrganization"
  );
  const defaultOrganizationId = await findDefaultOrganizationId().catch((e: unknown) => {
    throw convertErrorWithCodeToTRPCError(e);
  });
  return createOrganizationUser(prisma, data, defaultOrganizationId);
};

export const addUserHandler = async ({ ctx, input }: AddUserOptions) => {
  const { prisma } = ctx;
  const { avatarUrl, organizationId: requestedOrganizationId, ...rest } = input;
  const hasUploadedAvatar = isImageDataUrl(avatarUrl);
  const data = { ...rest, avatarUrl: hasUploadedAvatar ? null : avatarUrl };

  const created = isOrganizationsEnabled()
    ? await createOrganizationUser(prisma, data, requestedOrganizationId)
    : await createUserWithOrganizationsDisabled(prisma, data);

  const user = hasUploadedAvatar
    ? await prisma.user.update({
        where: { id: created.id },
        data: { avatarUrl: await storeAdminUserAvatar(created.id, avatarUrl) },
      })
    : created;
  return { user, message: `User with id: ${user.id} added successfully` };
};

export default addUserHandler;
