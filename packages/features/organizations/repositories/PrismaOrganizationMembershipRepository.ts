import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { v4 as uuidv4 } from "uuid";
import type {
  AddMemberInput,
  IOrganizationMembershipRepository,
  MembershipUserRecord,
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

export class PrismaOrganizationMembershipRepository implements IOrganizationMembershipRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findUserById(userId: number): Promise<MembershipUserRecord | null> {
    return this.prismaClient.user.findUnique({
      where: { id: userId },
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
        data: { organizationId },
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

  async countOwners(organizationId: number): Promise<number> {
    return this.prismaClient.membership.count({
      where: { teamId: organizationId, role: MembershipRole.OWNER, accepted: true },
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
}
