import { MembershipRole } from "@calcom/prisma/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrgPbacProcedure, createTeamPbacProcedure } from "./pbacProcedures";

const { findTeamIdsByAcceptedRole } = vi.hoisted(() => ({ findTeamIdsByAcceptedRole: vi.fn() }));

vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {
    findTeamIdsByAcceptedRole = findTeamIdsByAcceptedRole;
  },
}));

type AnyProcedure = { _def: { middlewares: ((opts: unknown) => Promise<unknown>)[] } };
const lastMiddleware = (procedure: unknown) => {
  const { middlewares } = (procedure as AnyProcedure)._def;
  return middlewares[middlewares.length - 1];
};

const next = vi.fn().mockResolvedValue({ ok: true });
const run = (procedure: unknown, organizationId: number | null = 7) =>
  lastMiddleware(procedure)({
    ctx: { user: { id: 1, organizationId }, prisma: {} },
    input: { teamId: 10 },
    next,
    path: "test",
    type: "query",
    getRawInput: async () => ({}),
    meta: undefined,
  });

describe("pbacProcedures (real role check, no stub)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createTeamPbacProcedure refuses a user without the required accepted role", async () => {
    findTeamIdsByAcceptedRole.mockResolvedValue([]);

    await expect(run(createTeamPbacProcedure("team.update"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(next).not.toHaveBeenCalled();
    expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        teamId: 10,
        teamRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
      })
    );
  });

  it("createTeamPbacProcedure lets an accepted team admin through", async () => {
    findTeamIdsByAcceptedRole.mockResolvedValue([10]);

    await run(createTeamPbacProcedure("team.update"));

    expect(next).toHaveBeenCalled();
  });

  it("createOrgPbacProcedure refuses a user without an accepted org admin/owner role", async () => {
    findTeamIdsByAcceptedRole.mockResolvedValue([]);

    await expect(run(createOrgPbacProcedure("organization.update"))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith(expect.objectContaining({ teamId: 7 }));
  });

  it("createOrgPbacProcedure passes an accepted org admin with the organization id", async () => {
    findTeamIdsByAcceptedRole.mockResolvedValue([7]);

    await run(createOrgPbacProcedure("organization.update"));

    expect(next).toHaveBeenCalledWith({ ctx: expect.objectContaining({ organizationId: 7 }) });
  });

  it("createOrgPbacProcedure refuses users outside any organization", async () => {
    await expect(run(createOrgPbacProcedure("organization.update"), null)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
