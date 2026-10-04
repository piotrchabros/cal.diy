import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { MembershipRole } from "@calcom/prisma/enums";
import type { Membership, Prisma, PrismaClient, Team } from "@calcom/prisma/client";
import slugify from "@calcom/lib/slugify";

import type {
  TDisbandTeamInput,
  TTeamProfileMetadata,
  TUpdateTeamProfileInput,
} from "@calcom/trpc/server/routers/viewer/teams/teamProfile.schema";
import { ZTeamProfileMetadataSchema } from "@calcom/trpc/server/routers/viewer/teams/teamProfile.schema";

type PrismaLike = Pick<PrismaClient, "membership" | "team">;

export type TeamProfile = Pick<Team, "id" | "name" | "slug" | "logoUrl" | "bio" | "metadata"> & {
  role: MembershipRole;
  location: string | null;
  showMap: boolean;
  socialLinks: { platform: string; url: string }[];
};

const teamProfileSelect = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  bio: true,
  metadata: true,
  parentId: true,
} satisfies Prisma.TeamSelect;

const parseProfileMetadata = (metadata: unknown): TTeamProfileMetadata => {
  const parsed = ZTeamProfileMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) {
    return {};
  }
  return parsed.data;
};

export class TeamProfileService {
  constructor(private prisma: PrismaLike) {}

  private async getAcceptedMembership(userId: number, teamId: number): Promise<Membership> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
      select: { id: true, teamId: true, userId: true, accepted: true, role: true },
    });
    if (!membership || !membership.accepted) {
      throw new ErrorWithCode(
        ErrorCode.NotFound,
        `Team profile not found: no accepted membership for user ${userId} on team ${teamId}`
      );
    }
    return membership as Membership;
  }

  async getTeamProfile({ teamId, userId }: { teamId: number; userId: number }): Promise<TeamProfile> {
    const membership = await this.getAcceptedMembership(userId, teamId);
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: teamProfileSelect,
    });
    if (!team) {
      throw new ErrorWithCode(ErrorCode.NotFound, `Team profile not found: team ${teamId} does not exist`);
    }
    const profileMeta = parseProfileMetadata(team.metadata);
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      logoUrl: team.logoUrl,
      bio: team.bio,
      metadata: team.metadata,
      role: membership.role,
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
    const membership = await this.getAcceptedMembership(userId, teamId);
    if (membership.role !== MembershipRole.ADMIN && membership.role !== MembershipRole.OWNER) {
      throw new ErrorWithCode(
        ErrorCode.Forbidden,
        `Unable to update team ${teamId}: user ${userId} is not an admin or owner`
      );
    }

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: teamProfileSelect,
    });
    if (!team) {
      throw new ErrorWithCode(ErrorCode.NotFound, `Unable to update team: team ${teamId} does not exist`);
    }

    const slug = slugify(input.slug);
    const slugTaken = await this.prisma.team.findFirst({
      where: {
        slug,
        parentId: team.parentId,
        NOT: { id: teamId },
      },
      select: { id: true },
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

    const updated = await this.prisma.team.update({
      where: { id: teamId },
      data: {
        name: input.name,
        slug,
        bio: input.bio ?? null,
        logoUrl: input.logoUrl ?? null,
        metadata: metadata as Prisma.InputJsonValue,
      },
      select: teamProfileSelect,
    });

    const updatedMeta = parseProfileMetadata(updated.metadata);
    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      logoUrl: updated.logoUrl,
      bio: updated.bio,
      metadata: updated.metadata,
      role: membership.role,
      location: updatedMeta.location ?? null,
      showMap: updatedMeta.showMap ?? false,
      socialLinks: updatedMeta.socialLinks ?? [],
    };
  }

  async disbandTeam({ teamId, userId }: TDisbandTeamInput & { userId: number }): Promise<{ id: number }> {
    const membership = await this.getAcceptedMembership(userId, teamId);
    if (membership.role !== MembershipRole.OWNER) {
      throw new ErrorWithCode(
        ErrorCode.Forbidden,
        `Unable to disband team ${teamId}: user ${userId} is not the team owner`
      );
    }
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      throw new ErrorWithCode(ErrorCode.NotFound, `Unable to disband team: team ${teamId} does not exist`);
    }
    await this.prisma.team.delete({ where: { id: teamId } });
    return { id: teamId };
  }
}
