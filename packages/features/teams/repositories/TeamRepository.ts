import type { TeamWithOrganizationDto } from "@calcom/lib/dto/TeamWithOrganizationDto";
import type { PrismaClient } from "@calcom/prisma";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { MembershipRole } from "@calcom/prisma/enums";

export class TeamRepository {
  constructor(private readonly prismaClient: PrismaClient = prisma) {}

  async findBasicById({ teamId }: { teamId: number }) {
    return await this.prismaClient.team.findUnique({
      where: {
        id: teamId,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        isOrganization: true,
        parentId: true,
      },
    });
  }

  // `parentId: undefined` searches every team; `null` only teams outside any organization.
  async findIdBySlug({
    slug,
    parentId,
    excludeTeamId,
  }: {
    slug: string;
    parentId?: number | null;
    excludeTeamId?: number;
  }) {
    return await this.prismaClient.team.findFirst({
      where: {
        slug,
        ...(parentId !== undefined && { parentId }),
        ...(excludeTeamId !== undefined && { NOT: { id: excludeTeamId } }),
      },
      select: { id: true },
    });
  }

  async createWithOwner({
    name,
    slug,
    bio,
    logoUrl,
    parentId,
    ownerUserId,
  }: {
    name: string;
    slug: string;
    bio: string | null;
    logoUrl: string | null;
    parentId: number | null;
    ownerUserId: number;
  }) {
    return await this.prismaClient.team.create({
      select: { id: true, name: true, slug: true, bio: true, logoUrl: true },
      data: {
        name,
        slug,
        bio,
        logoUrl,
        ...(parentId != null && { parentId }),
        members: {
          create: { userId: ownerUserId, role: MembershipRole.OWNER, accepted: true },
        },
      },
    });
  }

  async createTeamInviteToken({
    teamId,
    email,
    token,
    expires,
  }: {
    teamId: number;
    email: string;
    token: string;
    expires: Date;
  }) {
    return await this.prismaClient.verificationToken.create({
      data: {
        identifier: email.toLowerCase(),
        token,
        expires,
        teamId,
      },
      select: {
        id: true,
        token: true,
        expires: true,
      },
    });
  }

  async findTeamInviteTokenByEmail({ teamId, email }: { teamId: number; email: string }) {
    return await this.prismaClient.verificationToken.findFirst({
      where: {
        teamId,
        identifier: email.toLowerCase(),
      },
      select: {
        id: true,
        token: true,
        expires: true,
      },
    });
  }

  async findTeamInviteByToken({ token }: { token: string }) {
    return await this.prismaClient.verificationToken.findFirst({
      where: {
        token,
        teamId: { not: null },
      },
      select: {
        identifier: true,
        teamId: true,
        expires: true,
      },
    });
  }

  async findTeamInviteTokensByEmail({ email }: { email: string }) {
    return await this.prismaClient.verificationToken.findMany({
      where: {
        identifier: email.toLowerCase(),
      },
      select: {
        id: true,
        teamId: true,
        token: true,
        expires: true,
        team: { select: { id: true, parentId: true } },
      },
    });
  }

  async deleteTeamInviteTokens({ teamId, email }: { teamId: number; email: string }) {
    return await this.prismaClient.verificationToken.deleteMany({
      where: {
        teamId,
        identifier: email.toLowerCase(),
      },
    });
  }

  async findManyPaginated({
    search,
    parentId,
    cursor,
    limit,
  }: {
    search?: string | null;
    parentId?: number | null;
    cursor?: number | null;
    limit: number;
  }): Promise<{ items: TeamWithOrganizationDto[]; nextCursor?: number; total: number }> {
    const trimmedSearch = search?.trim();
    const where: Prisma.TeamWhereInput = {
      isOrganization: false,
      ...(parentId != null && { parentId }),
      ...(trimmedSearch && {
        OR: [
          { name: { contains: trimmedSearch, mode: "insensitive" } },
          { slug: { contains: trimmedSearch, mode: "insensitive" } },
        ],
      }),
    };

    const [rows, total] = await Promise.all([
      this.prismaClient.team.findMany({
        where: { ...where, ...(cursor != null && { id: { gt: cursor } }) },
        orderBy: { id: "asc" },
        take: limit + 1,
        select: {
          id: true,
          name: true,
          slug: true,
          _count: { select: { members: { where: { accepted: true } } } },
          parent: { select: { id: true, name: true } },
        },
      }),
      this.prismaClient.team.count({ where }),
    ]);

    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      memberCount: row._count.members,
      organization: row.parent ? { id: row.parent.id, name: row.parent.name } : null,
    }));
    if (rows.length <= limit) return { items, total };
    return { items, nextCursor: items[limit - 1].id, total };
  }
}
