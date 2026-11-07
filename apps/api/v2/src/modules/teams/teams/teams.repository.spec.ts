jest.mock(
  "@calcom/platform-libraries",
  () => ({
    teamMetadataSchema: { parse: jest.fn() },
  }),
  { virtual: true }
);

import { TeamsRepository } from "./teams.repository";
import type { PrismaReadService } from "@/modules/prisma/prisma-read.service";
import type { PrismaWriteService } from "@/modules/prisma/prisma-write.service";

describe("TeamsRepository.findTeamBySlug", () => {
  const originalFlag = process.env.ORGANIZATIONS_ENABLED;
  let findFirst: jest.Mock;
  let repository: TeamsRepository;

  beforeEach(() => {
    findFirst = jest.fn().mockResolvedValue({ id: 5, slug: "sales" });
    const dbRead = { prisma: { team: { findFirst } } } as unknown as PrismaReadService;
    repository = new TeamsRepository(dbRead, {} as unknown as PrismaWriteService);
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.ORGANIZATIONS_ENABLED;
    } else {
      process.env.ORGANIZATIONS_ENABLED = originalFlag;
    }
  });

  it("only matches top-level teams when organizations are enabled", async () => {
    process.env.ORGANIZATIONS_ENABLED = "true";

    await expect(repository.findTeamBySlug("sales")).resolves.toEqual({ id: 5, slug: "sales" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { slug: "sales", isOrganization: false, parentId: null },
    });
  });

  it("ignores the BlueBee parent when organizations are disabled", async () => {
    process.env.ORGANIZATIONS_ENABLED = "";

    await repository.findTeamBySlug("sales");
    expect(findFirst).toHaveBeenCalledWith({
      where: { slug: "sales", isOrganization: false },
    });
  });
});
