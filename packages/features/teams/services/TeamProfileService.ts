import type { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import type {
  TDisbandTeamInput,
  TTeamProfileMetadata,
  TUpdateTeamProfileInput,
} from "@calcom/features/teams/lib/teamProfileSchema";
import {
  TEAM_LOGO_DATA_URL_PATTERN,
  ZTeamProfileMetadataSchema,
} from "@calcom/features/teams/lib/teamProfileSchema";
import type { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { uploadLogo } from "@calcom/lib/server/avatar";
import { isBase64Image, resizeBase64Image } from "@calcom/lib/server/resizeBase64Image";
import slugify from "@calcom/lib/slugify";
import type { EventType, Prisma, Team } from "@calcom/prisma/client";
import { MembershipRole } from "@calcom/prisma/enums";

export interface ITeamProfileServiceRepositories {
  teamRepo: Pick<
    TeamRepository,
    | "findProfileById"
    | "findIdBySlug"
    | "updateProfile"
    | "findPublicBySlugIncludeEventTypes"
    | "findPublicOrganizationByIdIncludeEventTypes"
    | "deleteById"
  >;
  membershipRepo: Pick<MembershipRepository, "findRoleAndAcceptedByUserIdAndTeamId">;
}

export type TeamProfile = Pick<Team, "id" | "name" | "slug" | "logoUrl" | "bio" | "metadata"> & {
  role: MembershipRole;
  location: string | null;
  showMap: boolean;
  socialLinks: { platform: string; url: string }[];
};

export type PublicTeamEventType = Pick<EventType, "id" | "title" | "slug" | "description" | "length">;

export type PublicTeamProfile = Pick<Team, "id" | "name" | "slug" | "logoUrl" | "bio"> & {
  location: string | null;
  socialLinks: { platform: string; url: string }[];
  hideBookATeamMember: boolean;
  eventTypes: PublicTeamEventType[];
};

type PublicTeamRow = NonNullable<Awaited<ReturnType<TeamRepository["findPublicBySlugIncludeEventTypes"]>>>;

type TeamAccess = {
  team: NonNullable<Awaited<ReturnType<TeamRepository["findProfileById"]>>>;
  membershipRole: MembershipRole | null;
  isOrganizationAdmin: boolean;
};

// Org admins have owner authority over the org's teams, so they also see the danger zone (US4-6).
const effectiveRole = ({ membershipRole, isOrganizationAdmin }: TeamAccess): MembershipRole =>
  isOrganizationAdmin ? MembershipRole.OWNER : (membershipRole ?? MembershipRole.MEMBER);

const parseProfileMetadata = (metadata: unknown): TTeamProfileMetadata => {
  const parsed = ZTeamProfileMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) {
    return {};
  }
  return parsed.data;
};

export type UploadTeamLogo = (input: { teamId: number; logo: string }) => Promise<string>;

export const defaultUploadTeamLogo: UploadTeamLogo = async ({ teamId, logo }) => {
  // SVGs skip resizing: uploadLogo rasterises them to PNG itself.
  const resized = isBase64Image(logo) ? await resizeBase64Image(logo) : logo;
  return await uploadLogo({ teamId, logo: resized });
};

export type GetOrganizationRole = (
  userId: number,
  organizationId: number
) => Promise<OrganizationRoleDto | null>;

// Lazy so public team pages that construct this service don't load the organizations DI graph.
const defaultGetOrganizationRole: GetOrganizationRole = async (userId, organizationId) => {
  const { getOrganizationMembershipService } = await import(
    "@calcom/features/organizations/di/OrganizationMembershipService.container"
  );
  return getOrganizationMembershipService().getRole(userId, organizationId);
};

export type DisableTeamRedirects = (params: { organizationId: number; slug: string }) => Promise<void>;

const defaultDisableTeamRedirects: DisableTeamRedirects = async ({ organizationId, slug }) => {
  const { getTempOrgRedirectRepository } = await import(
    "@calcom/features/organizations/di/TempOrgRedirectRepository.container"
  );
  await getTempOrgRedirectRepository().disableByFrom({
    fromOrgId: organizationId,
    from: slug,
    types: ["Team", "TeamEventType"],
  });
};

export class TeamProfileService {
  constructor(
    private repositories: ITeamProfileServiceRepositories,
    private uploadTeamLogo: UploadTeamLogo = defaultUploadTeamLogo,
    private getOrganizationRole: GetOrganizationRole = defaultGetOrganizationRole,
    private disableTeamRedirects: DisableTeamRedirects = defaultDisableTeamRedirects
  ) {}

  private async resolveAccess(userId: number, teamId: number): Promise<TeamAccess> {
    const team = await this.repositories.teamRepo.findProfileById({ teamId });
    // Organization rows are not teams; treating them as one would let team admins edit or delete the org.
    if (!team || team.isOrganization) {
      throw new ErrorWithCode(ErrorCode.NotFound, `Team profile not found: team ${teamId} does not exist`);
    }

    const membership = await this.repositories.membershipRepo.findRoleAndAcceptedByUserIdAndTeamId({
      userId,
      teamId,
    });
    const membershipRole = membership?.accepted ? membership.role : null;

    let isOrganizationAdmin = false;
    if (isOrganizationsEnabled() && team.parentId) {
      const organizationRole = await this.getOrganizationRole(userId, team.parentId);
      isOrganizationAdmin = organizationRole === "OWNER" || organizationRole === "ADMIN";
    }

    if (!membershipRole && !isOrganizationAdmin) {
      throw new ErrorWithCode(
        ErrorCode.NotFound,
        `Team profile not found: no accepted membership for user ${userId} on team ${teamId}`
      );
    }
    return { team, membershipRole, isOrganizationAdmin };
  }

  async getTeamProfile({ teamId, userId }: { teamId: number; userId: number }): Promise<TeamProfile> {
    const access = await this.resolveAccess(userId, teamId);
    const { team } = access;
    const profileMeta = parseProfileMetadata(team.metadata);
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      logoUrl: team.logoUrl,
      bio: team.bio,
      metadata: team.metadata,
      role: effectiveRole(access),
      location: profileMeta.location ?? null,
      showMap: profileMeta.showMap ?? false,
      socialLinks: profileMeta.socialLinks ?? [],
    };
  }

  async updateTeamProfile({
    teamId,
    userId,
    input,
  }: {
    teamId: number;
    userId: number;
    input: TUpdateTeamProfileInput;
  }): Promise<TeamProfile> {
    const access = await this.resolveAccess(userId, teamId);
    const { team, membershipRole, isOrganizationAdmin } = access;
    const isTeamAdmin = membershipRole === MembershipRole.ADMIN || membershipRole === MembershipRole.OWNER;
    if (!isTeamAdmin && !isOrganizationAdmin) {
      throw new ErrorWithCode(
        ErrorCode.Forbidden,
        `Unable to update team ${teamId}: user ${userId} is not an admin or owner`
      );
    }

    const slug = slugify(input.slug);
    const slugTaken = await this.repositories.teamRepo.findIdBySlug({
      slug,
      parentId: team.parentId,
      excludeTeamId: teamId,
    });
    if (slugTaken) {
      throw new ErrorWithCode(
        ErrorCode.BadRequest,
        `Unable to update team ${teamId}: URL slug "${slug}" is already taken`
      );
    }

    const existingMeta = parseProfileMetadata(team.metadata);
    const metadata: TTeamProfileMetadata = {
      ...existingMeta,
      location: input.location ?? existingMeta.location,
      showMap: input.showMap ?? existingMeta.showMap,
      socialLinks: input.socialLinks ?? existingMeta.socialLinks,
    };

    // Uploaded images arrive as data URLs; they are stored in the Avatar table and the team keeps
    // a short /api/avatar URL, the same way user avatars are handled.
    const logoUrl =
      input.logoUrl && TEAM_LOGO_DATA_URL_PATTERN.test(input.logoUrl)
        ? await this.uploadTeamLogo({ teamId, logo: input.logoUrl })
        : (input.logoUrl ?? null);

    const updated = await this.repositories.teamRepo.updateProfile({
      teamId,
      data: {
        name: input.name,
        slug,
        bio: input.bio ?? null,
        logoUrl,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });

    // A slug freed by a team move may still redirect to the moved team; the renamed team wins
    if (team.parentId !== null && slug !== team.slug) {
      await this.disableTeamRedirects({ organizationId: team.parentId, slug });
    }

    const updatedMeta = parseProfileMetadata(updated.metadata);
    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      logoUrl: updated.logoUrl,
      bio: updated.bio,
      metadata: updated.metadata,
      role: effectiveRole(access),
      location: updatedMeta.location ?? null,
      showMap: updatedMeta.showMap ?? false,
      socialLinks: updatedMeta.socialLinks ?? [],
    };
  }

  async getPublicTeamBySlug({
    slug,
    parentId,
  }: {
    slug: string;
    parentId?: number;
  }): Promise<PublicTeamProfile | null> {
    const normalizedSlug = slugify(slug);
    if (!normalizedSlug) return null;
    const team = await this.repositories.teamRepo.findPublicBySlugIncludeEventTypes({
      slug: normalizedSlug,
      parentId,
    });
    if (!team) return null;
    return this.toPublicTeamProfile(team);
  }

  async getPublicOrganizationById({
    organizationId,
  }: {
    organizationId: number;
  }): Promise<PublicTeamProfile | null> {
    const organization = await this.repositories.teamRepo.findPublicOrganizationByIdIncludeEventTypes({
      organizationId,
    });
    if (!organization) return null;
    return this.toPublicTeamProfile(organization);
  }

  private toPublicTeamProfile(team: PublicTeamRow): PublicTeamProfile {
    const profileMeta = parseProfileMetadata(team.metadata);
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      logoUrl: team.logoUrl,
      bio: team.bio,
      location: profileMeta.location ?? null,
      socialLinks: profileMeta.socialLinks ?? [],
      hideBookATeamMember: team.hideBookATeamMember,
      eventTypes: team.eventTypes,
    };
  }

  async disbandTeam({ teamId, userId }: TDisbandTeamInput & { userId: number }): Promise<{ id: number }> {
    const { membershipRole, isOrganizationAdmin } = await this.resolveAccess(userId, teamId);
    if (membershipRole !== MembershipRole.OWNER && !isOrganizationAdmin) {
      throw new ErrorWithCode(
        ErrorCode.Forbidden,
        `Unable to disband team ${teamId}: user ${userId} is not the team owner`
      );
    }
    await this.repositories.teamRepo.deleteById({ teamId });
    return { id: teamId };
  }
}
