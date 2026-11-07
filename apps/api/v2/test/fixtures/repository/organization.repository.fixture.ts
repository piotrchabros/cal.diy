import type { Prisma, Team } from "@calcom/prisma/client";
import { TestingModule } from "@nestjs/testing";
import { getOrCreateDefaultOrganizationId } from "./users.repository.fixture";
import { PrismaReadService } from "@/modules/prisma/prisma-read.service";
import { PrismaWriteService } from "@/modules/prisma/prisma-write.service";

export class OrganizationRepositoryFixture {
  private primaReadClient: PrismaReadService["prisma"];
  private prismaWriteClient: PrismaWriteService["prisma"];

  constructor(module: TestingModule) {
    this.primaReadClient = module.get(PrismaReadService).prisma;
    this.prismaWriteClient = module.get(PrismaWriteService).prisma;
  }

  async get(teamId: Team["id"]) {
    return this.primaReadClient.team.findFirst({ where: { id: teamId } });
  }

  async create(data: Prisma.TeamCreateInput) {
    return await this.prismaWriteClient.$transaction(async (prisma) => {
      const team = await prisma.team.create({
        data: {
          ...data,
          isOrganization: true,
        },
      });

      await prisma.organizationSettings.create({
        data: {
          organizationId: team.id,
          isAdminAPIEnabled: true,
          orgAutoAcceptEmail: "cal.com",
        },
      });
      return team;
    });
  }

  async updateSettings(
    teamId: Team["id"],
    settings: {
      orgAutoAcceptEmail?: string;
      isOrganizationVerified?: boolean;
      isOrganizationConfigured?: boolean;
    }
  ) {
    return this.prismaWriteClient.organizationSettings.update({
      where: { organizationId: teamId },
      data: settings,
    });
  }

  async delete(teamId: Team["id"]) {
    const defaultOrganizationId = await getOrCreateDefaultOrganizationId(this.prismaWriteClient);
    return await this.prismaWriteClient.$transaction(async (prisma) => {
      // users.organizationId is ON DELETE RESTRICT. Callers often delete the org's users after the org,
      // so the users are moved to the default organization rather than deleted here.
      await prisma.user.updateMany({
        where: { organizationId: teamId },
        data: { organizationId: defaultOrganizationId },
      });
      await prisma.organizationSettings.delete({
        where: { organizationId: teamId },
      });
      return prisma.team.delete({ where: { id: teamId } });
    });
  }
}
