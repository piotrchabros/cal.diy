import process from "node:process";
import { sendEmailVerification } from "@calcom/features/auth/lib/verifyEmail";
import { SIGNUP_ERROR_CODES } from "@calcom/features/auth/signup/constants";
import { createOrUpdateMemberships } from "@calcom/features/auth/signup/utils/createOrUpdateMemberships";
import { joinAnyChildTeamOnOrgInvite } from "@calcom/features/auth/signup/utils/organization";
import { prefillAvatar } from "@calcom/features/auth/signup/utils/prefillAvatar";
import {
  findTokenByToken,
  throwIfTokenExpired,
  validateAndGetCorrectedUsernameForTeam,
} from "@calcom/features/auth/signup/utils/token";
import { validateAndGetCorrectedUsernameAndEmail } from "@calcom/features/auth/signup/utils/validateUsername";
import { getUserRepository } from "@calcom/features/di/containers/UserRepository";
import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";
import { getOrganizationMembershipService } from "@calcom/features/organizations/di/OrganizationMembershipService.container";
import { findDefaultOrganizationId } from "@calcom/features/organizations/lib/defaultOrganization";
import { getOrgFromRequest } from "@calcom/features/organizations/lib/getOrgFromRequest";
import { hashPassword } from "@calcom/lib/auth/hashPassword";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { isPrismaError } from "@calcom/lib/server/getServerErrorFromUnknown";
import { isUsernameReservedDueToMigration } from "@calcom/lib/server/username";
import slugify from "@calcom/lib/slugify";
import { prisma } from "@calcom/prisma";
import { CreationSource, IdentityProvider } from "@calcom/prisma/enums";
import { signupSchema } from "@calcom/prisma/zod-utils";
import { NextResponse } from "next/server";

async function respondConflictAs409(writeMembership: () => Promise<void>): Promise<NextResponse | null> {
  try {
    await writeMembership();
    return null;
  } catch (error) {
    if (error instanceof ErrorWithCode && error.code === ErrorCode.Conflict) {
      return NextResponse.json({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS }, { status: 409 });
    }
    throw error;
  }
}

export default async function handler(body: Record<string, string>, requestHeaders: Pick<Headers, "get">) {
  const { email, password, language, token } = signupSchema.parse(body);
  const orgsEnabled = isOrganizationsEnabled();

  const userRepository = getUserRepository();

  const username = slugify(body.username);
  const userEmail = email.toLowerCase();

  if (!username) {
    return NextResponse.json({ message: "Invalid username" }, { status: 422 });
  }

  let foundToken: { id: number; teamId: number | null; expires: Date } | null = null;
  let correctedUsername = username;
  let hostOrgId: number | null = null;
  if (token) {
    foundToken = await findTokenByToken({ token });
    throwIfTokenExpired(foundToken?.expires);
    correctedUsername = await validateAndGetCorrectedUsernameForTeam({
      username,
      email: userEmail,
      teamId: foundToken?.teamId,
      isSignup: true,
    });

    if (foundToken?.teamId) {
      const existingUser = await userRepository.findByEmailWithInvitedTo({
        email: userEmail,
      });

      if (existingUser && existingUser.invitedTo !== foundToken.teamId) {
        return NextResponse.json({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS }, { status: 409 });
      }
    }
  } else {
    // Without an invite the user joins the org of the domain they signed up on (the default org on the default domain)
    if (orgsEnabled) {
      const hostOrg = await getOrgFromRequest(requestHeaders);
      if (!hostOrg) {
        return NextResponse.json({ message: "Organization not found" }, { status: 404 });
      }
      hostOrgId = hostOrg.id;
    } else {
      // Every user needs an org; null only until the default org has been created by its migration
      hostOrgId = await findDefaultOrganizationId();
    }
    const userValidation = await validateAndGetCorrectedUsernameAndEmail({
      username,
      email: userEmail,
      isSignup: true,
      // With the flag off usernames stay globally unique, so validation must not narrow to the default org
      ...(orgsEnabled && hostOrgId !== null && { usernameOrganizationId: hostOrgId }),
    });
    if (!userValidation.isValid) {
      logger.error("User validation failed", { userValidation });
      return NextResponse.json({ message: "Username or email is already taken" }, { status: 409 });
    }
    if (!userValidation.username) {
      return NextResponse.json({ message: "Invalid username" }, { status: 422 });
    }
    correctedUsername = userValidation.username;
  }

  const hashedPassword = await hashPassword(password);

  if (foundToken?.teamId) {
    const team = await prisma.team.findUnique({
      where: {
        id: foundToken.teamId,
      },
      include: {
        parent: {
          select: {
            id: true,
            slug: true,
            organizationSettings: true,
          },
        },
        organizationSettings: true,
      },
    });

    if (team) {
      const isInviteForATeamInOrganization = !!team.parent;
      const isCheckingUsernameInGlobalNamespace = !team.isOrganization && !isInviteForATeamInOrganization;

      // The migration reservation guards the old global namespace, which org-scoped usernames no longer share
      if (isCheckingUsernameInGlobalNamespace && !orgsEnabled) {
        const isUsernameAvailable = !(await isUsernameReservedDueToMigration(correctedUsername));
        if (!isUsernameAvailable) {
          return NextResponse.json({ message: "A user exists with that username" }, { status: 409 });
        }
      }

      const teamOrganizationId = team.isOrganization ? team.id : (team.parent?.id ?? null);
      // A team outside any org has no org namespace of its own, so its invitees join the host org
      let fallbackHostOrgId: number | null = null;
      if (teamOrganizationId === null && orgsEnabled) {
        fallbackHostOrgId = (await getOrgFromRequest(requestHeaders))?.id ?? null;
      } else if (teamOrganizationId === null) {
        fallbackHostOrgId = await findDefaultOrganizationId();
      }
      const organizationId = teamOrganizationId ?? fallbackHostOrgId;

      const existingUserByUsername = await userRepository.findByUsernameAndOrganizationId({
        username: correctedUsername,
        organizationId,
        excludeEmail: userEmail,
      });

      if (existingUserByUsername) {
        return NextResponse.json({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS }, { status: 409 });
      }

      let user: { id: number };
      try {
        user = await userRepository.upsertForSignup({
          email: userEmail,
          username: correctedUsername,
          hashedPassword,
          organizationId,
          emailVerified: new Date(Date.now()),
          identityProvider: IdentityProvider.CAL,
        });
      } catch (error) {
        if (isPrismaError(error) && error.code === "P2002") {
          const target = String(error.meta?.target ?? "");
          if (target.includes("email") || target.includes("username")) {
            return NextResponse.json({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS }, { status: 409 });
          }
        }
        throw error;
      }

      const conflictResponse = await respondConflictAs409(async () => {
        await createOrUpdateMemberships({ user, team });
        if (fallbackHostOrgId !== null) {
          await getOrganizationMembershipService().addMember({
            organizationId: fallbackHostOrgId,
            userId: user.id,
            role: "MEMBER",
          });
        }
      });
      if (conflictResponse) return conflictResponse;

      // Accept any child team invites for orgs.
      if (team.parent) {
        await joinAnyChildTeamOnOrgInvite({
          userId: user.id,
          org: team.parent,
        });
      }
    }

    // Cleanup token after use
    await prisma.verificationToken.delete({
      where: {
        id: foundToken.id,
      },
    });
  } else {
    if (!orgsEnabled) {
      const isUsernameAvailable = !(await isUsernameReservedDueToMigration(correctedUsername));
      if (!isUsernameAvailable) {
        return NextResponse.json({ message: "A user exists with that username" }, { status: 409 });
      }
    }
    let createdUser: { id: number };
    try {
      createdUser = await userRepository.create({
        username: correctedUsername,
        email: userEmail,
        hashedPassword,
        organizationId: hostOrgId,
        creationSource: CreationSource.WEBAPP,
        identityProvider: IdentityProvider.CAL,
        locked: false,
      });
    } catch (error) {
      // Fallback for race conditions where user was created between our check and create
      if (isPrismaError(error) && error.code === "P2002") {
        const target = String(error.meta?.target ?? "");
        if (target.includes("email") || target.includes("username")) {
          return NextResponse.json({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS }, { status: 409 });
        }
      }
      throw error;
    }
    if (hostOrgId !== null) {
      const organizationId = hostOrgId;
      const conflictResponse = await respondConflictAs409(async () => {
        await getOrganizationMembershipService().addMember({
          organizationId,
          userId: createdUser.id,
          role: "MEMBER",
        });
      });
      if (conflictResponse) return conflictResponse;
    }
    try {
      await new TeamMembersService().acceptPendingInvitesOnSignup({
        userId: createdUser.id,
        email: userEmail,
      });
    } catch {
      logger.error("Failed to materialize pending team invites on signup", { userId: createdUser.id });
    }

    if (process.env.AVATARAPI_USERNAME && process.env.AVATARAPI_PASSWORD) {
      await prefillAvatar({ email: userEmail });
    }

    await sendEmailVerification({
      email: userEmail,
      username: correctedUsername,
      language,
    });
  }

  return NextResponse.json({ message: "Created user" }, { status: 201 });
}
