jest.mock(
  "@calcom/platform-libraries",
  () => ({
    MembershipRole: { MEMBER: "MEMBER", ADMIN: "ADMIN", OWNER: "OWNER" },
  }),
  { virtual: true }
);

import { MembershipsRepository } from "./memberships.repository";
import type { PrismaReadService } from "@/modules/prisma/prisma-read.service";
import type { PrismaWriteService } from "@/modules/prisma/prisma-write.service";

describe("MembershipsRepository organization filters", () => {
  const originalFlag = process.env.ORGANIZATIONS_ENABLED;
  let findMany: jest.Mock;
  let findFirst: jest.Mock;
  let repository: MembershipsRepository;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([{ teamId: 7 }]);
    findFirst = jest.fn().mockResolvedValue(null);
    const dbRead = { prisma: { membership: { findMany, findFirst } } } as unknown as PrismaReadService;
    repository = new MembershipsRepository(dbRead, {} as unknown as PrismaWriteService);
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.ORGANIZATIONS_ENABLED;
    } else {
      process.env.ORGANIZATIONS_ENABLED = originalFlag;
    }
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      process.env.ORGANIZATIONS_ENABLED = "1";
    });

    it("getOrgIdsWhereUserIsAdminOrOwner only matches top-level teams", async () => {
      await expect(repository.getOrgIdsWhereUserIsAdminOrOwner(3)).resolves.toEqual([7]);
      expect(findMany).toHaveBeenCalledWith({
        where: { userId: 3, accepted: true, role: { in: ["OWNER", "ADMIN"] }, team: { parentId: null } },
        select: { teamId: true },
      });
    });

    it("getUserMembershipInOneOfOrgs only matches top-level teams", async () => {
      await repository.getUserMembershipInOneOfOrgs(3, [7, 8]);
      expect(findFirst).toHaveBeenCalledWith({
        where: { userId: 3, accepted: true, teamId: { in: [7, 8] }, team: { parentId: null } },
      });
    });
  });

  describe("with organizations disabled", () => {
    beforeEach(() => {
      process.env.ORGANIZATIONS_ENABLED = "";
    });

    it("getOrgIdsWhereUserIsAdminOrOwner ignores the BlueBee parent and excludes organizations", async () => {
      await repository.getOrgIdsWhereUserIsAdminOrOwner(3);
      expect(findMany).toHaveBeenCalledWith({
        where: {
          userId: 3,
          accepted: true,
          role: { in: ["OWNER", "ADMIN"] },
          team: { isOrganization: false },
        },
        select: { teamId: true },
      });
    });

    it("getUserMembershipInOneOfOrgs ignores the BlueBee parent and excludes organizations", async () => {
      await repository.getUserMembershipInOneOfOrgs(3, [7]);
      expect(findFirst).toHaveBeenCalledWith({
        where: { userId: 3, accepted: true, teamId: { in: [7] }, team: { isOrganization: false } },
      });
    });
  });
});
