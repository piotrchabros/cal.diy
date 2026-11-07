import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { getOrCreateDefaultOrganizationId } from "./defaultOrganization";

type FakeTeamClient = {
  team: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

function buildFakePrisma(): { fake: FakeTeamClient; prisma: Pick<PrismaClient, "team"> } {
  const fake: FakeTeamClient = {
    team: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };
  return { fake, prisma: fake as unknown as Pick<PrismaClient, "team"> };
}

function uniqueConstraintError(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

describe("getOrCreateDefaultOrganizationId", () => {
  it("returns the existing default organization id without creating one", async () => {
    const { fake, prisma } = buildFakePrisma();
    fake.team.findFirst.mockResolvedValue({ id: 7 });

    await expect(getOrCreateDefaultOrganizationId(prisma)).resolves.toBe(7);
    expect(fake.team.create).not.toHaveBeenCalled();
    expect(fake.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isOrganization: true,
          organizationSettings: { customDomain: expect.any(String) },
        }),
      })
    );
  });

  it("creates the organization with the instance domain as customDomain when missing", async () => {
    const { fake, prisma } = buildFakePrisma();
    fake.team.findFirst.mockResolvedValue(null);
    fake.team.create.mockResolvedValue({ id: 11 });

    await expect(getOrCreateDefaultOrganizationId(prisma)).resolves.toBe(11);

    const lookupDomain = fake.team.findFirst.mock.calls[0][0].where.organizationSettings.customDomain;
    expect(fake.team.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isOrganization: true,
          organizationSettings: {
            create: expect.objectContaining({ customDomain: lookupDomain }),
          },
        }),
      })
    );
  });

  it("returns the race winner's id when creation hits a unique constraint", async () => {
    const { fake, prisma } = buildFakePrisma();
    fake.team.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 23 });
    fake.team.create.mockRejectedValue(uniqueConstraintError());

    await expect(getOrCreateDefaultOrganizationId(prisma)).resolves.toBe(23);
    expect(fake.team.findFirst).toHaveBeenCalledTimes(2);
  });

  it("rethrows the unique constraint error when the race winner cannot be found", async () => {
    const { fake, prisma } = buildFakePrisma();
    const error = uniqueConstraintError();
    fake.team.findFirst.mockResolvedValue(null);
    fake.team.create.mockRejectedValue(error);

    await expect(getOrCreateDefaultOrganizationId(prisma)).rejects.toBe(error);
  });

  it("rethrows errors that are not unique constraint violations", async () => {
    const { fake, prisma } = buildFakePrisma();
    const error = new Error("connection lost");
    fake.team.findFirst.mockResolvedValue(null);
    fake.team.create.mockRejectedValue(error);

    await expect(getOrCreateDefaultOrganizationId(prisma)).rejects.toBe(error);
    expect(fake.team.findFirst).toHaveBeenCalledTimes(1);
  });
});
