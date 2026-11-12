import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { PrismaOrganizationEmailSenderRepository } from "./PrismaOrganizationEmailSenderRepository";

const record = {
  organizationId: 7,
  emailFromName: "Acme",
  emailFromAddress: "no-reply@acme.com",
  customDomain: "acme.com",
};
const selectShape = { organizationId: true, emailFromName: true, emailFromAddress: true, customDomain: true };

function buildRepository() {
  const settingsFindUnique = vi.fn();
  const settingsUpsert = vi.fn().mockResolvedValue(record);
  const teamFindFirst = vi.fn();
  const teamFindUnique = vi.fn();
  const userFindUnique = vi.fn();
  const userFindFirst = vi.fn();
  const eventTypeFindUnique = vi.fn();
  const prismaClient = {
    organizationSettings: { findUnique: settingsFindUnique, upsert: settingsUpsert },
    team: { findFirst: teamFindFirst, findUnique: teamFindUnique },
    user: { findUnique: userFindUnique, findFirst: userFindFirst },
    eventType: { findUnique: eventTypeFindUnique },
  } as unknown as PrismaClient;
  return {
    repository: new PrismaOrganizationEmailSenderRepository(prismaClient),
    settingsFindUnique,
    settingsUpsert,
    teamFindFirst,
    teamFindUnique,
    userFindUnique,
    userFindFirst,
    eventTypeFindUnique,
  };
}

describe("PrismaOrganizationEmailSenderRepository", () => {
  it("reads the sender settings with an explicit select", async () => {
    const { repository, settingsFindUnique } = buildRepository();
    settingsFindUnique.mockResolvedValue(record);

    expect(await repository.findByOrganizationId(7)).toEqual(record);
    expect(settingsFindUnique).toHaveBeenCalledWith({ where: { organizationId: 7 }, select: selectShape });
  });

  it("returns null from update when the team is not a root organization", async () => {
    const { repository, teamFindFirst, settingsUpsert } = buildRepository();
    teamFindFirst.mockResolvedValue(null);

    const result = await repository.update(7, { emailFromName: "A", emailFromAddress: null });

    expect(result).toBeNull();
    expect(teamFindFirst).toHaveBeenCalledWith({
      where: { id: 7, isOrganization: true, parentId: null },
      select: { id: true },
    });
    expect(settingsUpsert).not.toHaveBeenCalled();
  });

  it("upserts with the organization defaults on create", async () => {
    const { repository, teamFindFirst, settingsUpsert } = buildRepository();
    teamFindFirst.mockResolvedValue({ id: 7 });
    const input = { emailFromName: "Acme", emailFromAddress: "no-reply@acme.com" };

    expect(await repository.update(7, input)).toEqual(record);

    expect(settingsUpsert).toHaveBeenCalledWith({
      where: { organizationId: 7 },
      create: {
        organizationId: 7,
        ...input,
        orgAutoAcceptEmail: "",
        isOrganizationConfigured: true,
        isOrganizationVerified: true,
        allowSEOIndexing: true,
      },
      update: input,
      select: selectShape,
    });
  });

  it("resolves the organization of a user by id", async () => {
    const { repository, userFindUnique } = buildRepository();
    userFindUnique.mockResolvedValueOnce({ organizationId: 7 }).mockResolvedValueOnce(null);

    expect(await repository.findOrganizationIdByUserId(1)).toBe(7);
    expect(await repository.findOrganizationIdByUserId(2)).toBeNull();
  });

  it("looks users up by lowercased email", async () => {
    const { repository, userFindFirst } = buildRepository();
    userFindFirst.mockResolvedValueOnce({ organizationId: 7 }).mockResolvedValueOnce(null);

    expect(await repository.findOrganizationIdByUserEmail("Jane@Acme.com")).toBe(7);
    expect(userFindFirst.mock.calls[0][0].where).toEqual({ email: "jane@acme.com" });
    expect(await repository.findOrganizationIdByUserEmail("x@y.z")).toBeNull();
  });

  it("resolves a team to itself when it is the organization, otherwise to its parent", async () => {
    const { repository, teamFindUnique } = buildRepository();
    teamFindUnique
      .mockResolvedValueOnce({ id: 7, isOrganization: true, parentId: null })
      .mockResolvedValueOnce({ id: 9, isOrganization: false, parentId: 7 })
      .mockResolvedValueOnce(null);

    expect(await repository.findOrganizationIdByTeamId(7)).toBe(7);
    expect(await repository.findOrganizationIdByTeamId(9)).toBe(7);
    expect(await repository.findOrganizationIdByTeamId(10)).toBeNull();
  });

  it("resolves an event type through its team, its owner, or to null", async () => {
    const { repository, eventTypeFindUnique, teamFindUnique, userFindUnique } = buildRepository();
    eventTypeFindUnique
      .mockResolvedValueOnce({ teamId: 9, userId: null })
      .mockResolvedValueOnce({ teamId: null, userId: 4 })
      .mockResolvedValueOnce({ teamId: null, userId: null })
      .mockResolvedValueOnce(null);
    teamFindUnique.mockResolvedValueOnce({ id: 9, isOrganization: false, parentId: 7 });
    userFindUnique.mockResolvedValueOnce({ organizationId: 8 });

    expect(await repository.findOrganizationIdByEventTypeId(1)).toBe(7);
    expect(await repository.findOrganizationIdByEventTypeId(2)).toBe(8);
    expect(await repository.findOrganizationIdByEventTypeId(3)).toBeNull();
    expect(await repository.findOrganizationIdByEventTypeId(4)).toBeNull();
    expect(eventTypeFindUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { teamId: true, userId: true },
    });
  });
});
