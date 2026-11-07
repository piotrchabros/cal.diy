import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { MembershipRole, RedirectType } from "@calcom/prisma/enums";
import { v4 as uuidv4 } from "uuid";
import type {
  ApplyMoveInput,
  ApplyTeamMove,
  ApplyUserMove,
  IOrganizationMoveRepository,
  MoveRedirectWrite,
  MoveTeamRecord,
  MoveUserRecord,
} from "./interfaces/IOrganizationMoveRepository";

const MOVE_TRANSACTION_TIMEOUT_MS = 30_000;

const toMembershipRole: Record<OrganizationRoleDto, MembershipRole> = {
  OWNER: MembershipRole.OWNER,
  ADMIN: MembershipRole.ADMIN,
  MEMBER: MembershipRole.MEMBER,
};

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export class PrismaOrganizationMoveRepository implements IOrganizationMoveRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async findUserForMove(userId: number): Promise<MoveUserRecord | null> {
    return this.prismaClient.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, organizationId: true },
    });
  }

  async findTeamForMove(teamId: number): Promise<MoveTeamRecord | null> {
    const row = await this.prismaClient.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        slug: true,
        parentId: true,
        isOrganization: true,
        members: {
          select: {
            accepted: true,
            user: { select: { id: true, name: true, email: true, username: true, organizationId: true } },
          },
        },
      },
    });
    if (!row) return null;
    return {
      ...row,
      members: row.members.map(({ accepted, user: { id, ...user } }) => ({ userId: id, ...user, accepted })),
    };
  }

  async isTeamSlugTaken({
    organizationId,
    slug,
    excludeTeamId,
  }: {
    organizationId: number;
    slug: string;
    excludeTeamId: number;
  }): Promise<boolean> {
    const team = await this.prismaClient.team.findFirst({
      where: { parentId: organizationId, slug, id: { not: excludeTeamId } },
      select: { id: true },
    });
    return team !== null;
  }

  async findTakenUsernames({
    organizationId,
    usernames,
    excludeUserIds,
  }: {
    organizationId: number;
    usernames: string[];
    excludeUserIds: number[];
  }): Promise<string[]> {
    if (usernames.length === 0) return [];

    const candidates = Array.from(new Set(usernames));
    const [users, profiles] = await Promise.all([
      this.prismaClient.user.findMany({
        where: { organizationId, username: { in: candidates }, id: { notIn: excludeUserIds } },
        select: { username: true },
      }),
      this.prismaClient.profile.findMany({
        where: { organizationId, username: { in: candidates }, userId: { notIn: excludeUserIds } },
        select: { username: true },
      }),
    ]);

    const taken = new Set<string>();
    for (const { username } of [...users, ...profiles]) {
      if (username) taken.add(username);
    }
    return Array.from(taken);
  }

  async applyMove(input: ApplyMoveInput): Promise<void> {
    try {
      await this.prismaClient.$transaction(
        async (tx) => {
          if (input.team) await this.applyTeamMove(tx, input.team);
          for (const user of input.users) {
            await this.applyUserMove(tx, user);
          }
        },
        { timeout: MOVE_TRANSACTION_TIMEOUT_MS }
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw ErrorWithCode.Factory.Conflict("move_conflict");
      throw error;
    }
  }

  private async applyTeamMove(tx: Prisma.TransactionClient, move: ApplyTeamMove): Promise<void> {
    const { teamId, toOrganizationId, slug, removeMembers, redirect } = move;
    await tx.team.update({
      where: { id: teamId },
      data: { parentId: toOrganizationId, slug },
      select: { id: true },
    });

    if (removeMembers.length > 0) {
      const userIds = removeMembers.map((member) => member.userId);
      await tx.membership.deleteMany({ where: { teamId, userId: { in: userIds } } });
      await tx.host.deleteMany({ where: { userId: { in: userIds }, eventType: { teamId } } });
      await tx.verificationToken.deleteMany({
        where: { teamId, identifier: { in: removeMembers.map((member) => member.email) } },
      });
    }

    const redirectTypes = [RedirectType.Team, RedirectType.TeamEventType];
    // Old redirects in the target org for this slug would shadow the team that now lives there.
    if (slug)
      await this.disableRedirects(tx, { fromOrgId: toOrganizationId, from: slug, types: redirectTypes });
    if (!redirect) return;
    for (const type of redirectTypes) {
      await this.upsertRedirect(tx, type, redirect);
    }
  }

  private async applyUserMove(tx: Prisma.TransactionClient, move: ApplyUserMove): Promise<void> {
    const { userId, email, fromOrganizationId, toOrganizationId, username, role, keepTeamIds, redirect } =
      move;

    const leftTeamIds = await this.findLeftTeamIds(tx, fromOrganizationId, keepTeamIds);
    if (leftTeamIds.length > 0) {
      await tx.membership.deleteMany({ where: { userId, teamId: { in: leftTeamIds } } });
      await tx.host.deleteMany({ where: { userId, eventType: { teamId: { in: leftTeamIds } } } });
      await tx.verificationToken.deleteMany({ where: { identifier: email, teamId: { in: leftTeamIds } } });
    }

    await tx.profile.deleteMany({ where: { userId, organizationId: toOrganizationId } });
    const oldProfile = await this.findProfile(tx, userId, fromOrganizationId);
    // Event types reference the profile, so it moves in place instead of being recreated.
    if (oldProfile) {
      await tx.profile.update({
        where: { id: oldProfile.id },
        data: { organizationId: toOrganizationId, username },
        select: { id: true },
      });
    } else {
      await tx.profile.create({
        data: { uid: uuidv4(), userId, organizationId: toOrganizationId, username },
        select: { id: true },
      });
    }

    await tx.user.update({
      where: { id: userId },
      data: { organizationId: toOrganizationId, username },
      select: { id: true },
    });

    await tx.membership.upsert({
      where: { userId_teamId: { userId, teamId: toOrganizationId } },
      create: { userId, teamId: toOrganizationId, role: toMembershipRole[role], accepted: true },
      // An existing membership is only ever promoted, so moving a user in can never demote them.
      update: { accepted: true, ...(role === "OWNER" && { role: MembershipRole.OWNER }) },
      select: { id: true },
    });

    await this.disableRedirects(tx, {
      fromOrgId: toOrganizationId,
      from: username,
      types: [RedirectType.User],
    });
    if (redirect) await this.upsertRedirect(tx, RedirectType.User, redirect);
  }

  private async findLeftTeamIds(
    tx: Prisma.TransactionClient,
    fromOrganizationId: number | null,
    keepTeamIds: number[]
  ): Promise<number[]> {
    if (fromOrganizationId === null) return [];

    const subTeams = await tx.team.findMany({
      where: { parentId: fromOrganizationId },
      select: { id: true },
    });
    const keep = new Set(keepTeamIds);
    return [fromOrganizationId, ...subTeams.map((team) => team.id)].filter((id) => !keep.has(id));
  }

  private async findProfile(
    tx: Prisma.TransactionClient,
    userId: number,
    organizationId: number | null
  ): Promise<{ id: number } | null> {
    if (organizationId === null) return null;

    return tx.profile.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { id: true },
    });
  }

  private async disableRedirects(
    tx: Prisma.TransactionClient,
    { fromOrgId, from, types }: { fromOrgId: number; from: string; types: RedirectType[] }
  ): Promise<void> {
    await tx.tempOrgRedirect.updateMany({
      where: { fromOrgId, from, type: { in: types }, enabled: true },
      data: { enabled: false },
    });
  }

  private async upsertRedirect(
    tx: Prisma.TransactionClient,
    type: RedirectType,
    { fromOrgId, from, toUrl }: MoveRedirectWrite
  ): Promise<void> {
    await tx.tempOrgRedirect.upsert({
      where: { from_type_fromOrgId: { from, type, fromOrgId } },
      create: { from, type, fromOrgId, toUrl },
      update: { toUrl, enabled: true },
      select: { id: true },
    });
  }
}
