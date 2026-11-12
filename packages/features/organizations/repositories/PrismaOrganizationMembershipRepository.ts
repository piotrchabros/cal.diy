import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { MembershipRole } from "@calcom/prisma/enums";
import { v4 as uuidv4 } from "uuid";
import { USERNAME_TAKEN_IN_ORGANIZATION } from "../services/OrganizationMembershipService";
import type {
  AddMemberInput,
  IOrganizationMembershipRepository,
  MembershipUserRecord,
  OrganizationMemberRecord,
  OrganizationTeamRecord,
} from "./interfaces/IOrganizationMembershipRepository";

const toRoleDto: Record<MembershipRole, OrganizationRoleDto> = {
  [MembershipRole.OWNER]: "OWNER",
  [MembershipRole.ADMIN]: "ADMIN",
  [MembershipRole.MEMBER]: "MEMBER",
};

const toMembershipRole: Record<OrganizationRoleDto, MembershipRole> = {
  OWNER: MembershipRole.OWNER,
  ADMIN: MembershipRole.ADMIN,
  MEMBER: MembershipRole.MEMBER,
};

const memberSelect = {
  id: true,
  role: true,
  accepted: true,
  user: { select: { id: true, name: true, email: true, username: true, avatarUrl: true, bio: true } },
} satisfies Prisma.MembershipSelect;

function toMemberRecord(
  row: Prisma.MembershipGetPayload<{ select: typeof memberSelect }>
): OrganizationMemberRecord {
  return {
    membershipId: row.id,
    userId: row.user.id,
    name: row.user.name,
    email: row.user.email,
    username: row.user.username,
    avatarUrl: row.user.avatarUrl,
    bio: row.user.bio,
    role: toRoleDto[row.role],
    accepted: row.accepted,
  };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export class PrismaOrganizationMembershipRepository implements IOrganizationMembershipRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findUserById(userId: number): Promise<MembershipUserRecord | null> {
    return this.prismaClient.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, organizationId: true },
    });
  }

  async findUserByEmail(email: string): Promise<MembershipUserRecord | null> {
    return this.prismaClient.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, username: true, email: true, organizationId: true },
    });
  }

  async isUsernameTaken({
    organizationId,
    username,
    excludeUserId,
  }: {
    organizationId: number;
    username: string;
    excludeUserId: number;
  }): Promise<boolean> {
    const [user, profile] = await Promise.all([
      this.prismaClient.user.findFirst({
        where: { username, organizationId, id: { not: excludeUserId } },
        select: { id: true },
      }),
      this.prismaClient.profile.findFirst({
        where: { username, organizationId, userId: { not: excludeUserId } },
        select: { id: true },
      }),
    ]);
    return user !== null || profile !== null;
  }

  async addMember({
    organizationId,
    userId,
    username,
    role,
  }: AddMemberInput): Promise<{ userId: number; organizationId: number; role: OrganizationRoleDto }> {
    const [, , membership] = await this.prismaClient.$transaction([
      this.prismaClient.user.update({
        where: { id: userId },
        data: { organizationId, username },
        select: { id: true },
      }),
      this.prismaClient.profile.upsert({
        where: { userId_organizationId: { userId, organizationId } },
        create: { uid: uuidv4(), userId, organizationId, username },
        update: { username },
        select: { id: true },
      }),
      this.prismaClient.membership.upsert({
        where: { userId_teamId: { userId, teamId: organizationId } },
        create: { userId, teamId: organizationId, role: toMembershipRole[role], accepted: true },
        // An existing membership keeps its role so re-adding a user can never demote an owner.
        update: { accepted: true },
        select: { role: true },
      }),
    ]);
    return { userId, organizationId, role: toRoleDto[membership.role] };
  }

  async findRole({
    organizationId,
    userId,
  }: {
    organizationId: number;
    userId: number;
  }): Promise<OrganizationRoleDto | null> {
    const membership = await this.prismaClient.membership.findUnique({
      where: { userId_teamId: { userId, teamId: organizationId } },
      select: { role: true, accepted: true },
    });
    if (!membership?.accepted) return null;
    return toRoleDto[membership.role];
  }

  async findMembership({
    organizationId,
    userId,
  }: {
    organizationId: number;
    userId: number;
  }): Promise<{ role: OrganizationRoleDto; accepted: boolean } | null> {
    const membership = await this.prismaClient.membership.findUnique({
      where: { userId_teamId: { userId, teamId: organizationId } },
      select: { role: true, accepted: true },
    });
    if (!membership) return null;
    return { role: toRoleDto[membership.role], accepted: membership.accepted };
  }

  async countOwners(organizationId: number): Promise<number> {
    return this.prismaClient.membership.count({
      where: { teamId: organizationId, role: MembershipRole.OWNER, accepted: true },
    });
  }

  async countPendingOwners(organizationId: number): Promise<number> {
    return this.prismaClient.membership.count({
      where: { teamId: organizationId, role: MembershipRole.OWNER, accepted: false },
    });
  }

  async updateRole({
    organizationId,
    userId,
    role,
  }: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<{ userId: number; role: OrganizationRoleDto }> {
    const membership = await this.prismaClient.membership.update({
      where: { userId_teamId: { userId, teamId: organizationId } },
      data: { role: toMembershipRole[role] },
      select: { userId: true, role: true },
    });
    return { userId: membership.userId, role: toRoleDto[membership.role] };
  }

  async listMembers({
    organizationId,
    search,
    cursor,
    limit,
  }: {
    organizationId: number;
    search?: string;
    cursor?: number;
    limit: number;
  }): Promise<{ items: OrganizationMemberRecord[]; nextCursor?: number }> {
    const rows = await this.prismaClient.membership.findMany({
      where: {
        teamId: organizationId,
        ...(cursor !== undefined && { id: { gt: cursor } }),
        ...(search && {
          user: {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
              { username: { contains: search, mode: "insensitive" } },
            ],
          },
        }),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
      select: memberSelect,
    });

    const items = rows.slice(0, limit).map(toMemberRecord);
    if (rows.length <= limit) return { items };
    return { items, nextCursor: items[limit - 1].membershipId };
  }

  async findMember({
    organizationId,
    userId,
  }: {
    organizationId: number;
    userId: number;
  }): Promise<OrganizationMemberRecord | null> {
    const row = await this.prismaClient.membership.findUnique({
      where: { userId_teamId: { userId, teamId: organizationId } },
      select: memberSelect,
    });
    return row ? toMemberRecord(row) : null;
  }

  async updateUserProfile({
    userId,
    data,
  }: {
    userId: number;
    data: { name?: string; bio?: string; avatarUrl?: string | null };
  }): Promise<void> {
    await this.prismaClient.user.update({ where: { id: userId }, data, select: { id: true } });
  }

  async listTeams({
    organizationId,
    viewerUserId,
    memberUserId,
    search,
    cursor,
    limit,
  }: {
    organizationId: number;
    viewerUserId: number;
    memberUserId?: number;
    search?: string;
    cursor?: number;
    limit: number;
  }): Promise<{ items: OrganizationTeamRecord[]; nextCursor?: number }> {
    const rows = await this.prismaClient.team.findMany({
      where: {
        parentId: organizationId,
        isOrganization: false,
        ...(memberUserId !== undefined && { members: { some: { userId: memberUserId, accepted: true } } }),
        ...(cursor !== undefined && { id: { gt: cursor } }),
        ...(search && {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { slug: { contains: search, mode: "insensitive" } },
          ],
        }),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
      select: {
        id: true,
        name: true,
        slug: true,
        _count: { select: { members: { where: { accepted: true } } } },
        members: { where: { userId: viewerUserId, accepted: true }, select: { id: true }, take: 1 },
      },
    });

    const items = rows.slice(0, limit).map((row) => ({
      teamId: row.id,
      name: row.name,
      slug: row.slug,
      memberCount: row._count.members,
      viewerIsMember: row.members.length > 0,
    }));
    if (rows.length <= limit) return { items };
    return { items, nextCursor: items[limit - 1].teamId };
  }

  async createPendingMembership({
    organizationId,
    userId,
    role,
  }: {
    organizationId: number;
    userId: number;
    role: OrganizationRoleDto;
  }): Promise<void> {
    await this.prismaClient.membership.create({
      data: { userId, teamId: organizationId, role: toMembershipRole[role], accepted: false },
      select: { id: true },
    });
  }

  async updateUsername({
    userId,
    organizationId,
    username,
  }: {
    userId: number;
    organizationId: number;
    username: string;
  }): Promise<void> {
    const userUpdate = this.prismaClient.user.update({
      where: { id: userId },
      data: { username },
      select: { id: true },
    });
    try {
      await this.prismaClient.$transaction([
        userUpdate,
        this.prismaClient.profile.updateMany({ where: { userId, organizationId }, data: { username } }),
      ]);
    } catch (error) {
      if (isUniqueConstraintViolation(error))
        throw ErrorWithCode.Factory.Conflict(USERNAME_TAKEN_IN_ORGANIZATION);
      throw error;
    }
  }

  async updateUsernameAndUpsertProfile({
    userId,
    organizationId,
    username,
  }: {
    userId: number;
    organizationId: number;
    username: string;
  }): Promise<void> {
    try {
      await this.prismaClient.$transaction([
        this.prismaClient.user.update({
          where: { id: userId },
          data: { username },
          select: { id: true },
        }),
        this.prismaClient.profile.upsert({
          where: { userId_organizationId: { userId, organizationId } },
          create: { uid: uuidv4(), userId, organizationId, username },
          update: { username },
          select: { id: true },
        }),
      ]);
    } catch (error) {
      if (isUniqueConstraintViolation(error))
        throw ErrorWithCode.Factory.Conflict(USERNAME_TAKEN_IN_ORGANIZATION);
      throw error;
    }
  }
}
