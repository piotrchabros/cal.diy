import type { PrismaClient } from "@calcom/prisma";
import { prisma } from "@calcom/prisma";

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
}
