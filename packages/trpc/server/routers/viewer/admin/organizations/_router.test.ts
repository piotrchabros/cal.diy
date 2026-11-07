import { ErrorWithCode } from "@calcom/lib/errors";
import prisma, { readonlyPrisma } from "@calcom/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TRPCContextInner } from "../../../../createContext";
import { createCallerFactory } from "../../../../trpc";
import { organizationsRouter } from "./_router";

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  demoteOwner: vi.fn(),
  delete: vi.fn(),
  moveUser: vi.fn(),
  previewMoveTeam: vi.fn(),
  moveTeam: vi.fn(),
  listTeams: vi.fn(),
}));

vi.mock("@calcom/features/auth/lib/userFromSessionUtils", () => ({
  getUserSession: mocks.getUserSession,
}));

vi.mock("@calcom/prisma", () => {
  const fake = {};
  return { default: fake, prisma: fake, readonlyPrisma: fake, availabilityUserSelect: {}, userSelect: {} };
});

vi.mock("@sentry/nextjs", () => ({ setUser: vi.fn() }));

vi.mock("@calcom/features/organizations/di/OrganizationService.container", () => ({
  getOrganizationService: () => ({
    list: mocks.list,
    get: mocks.get,
    create: mocks.create,
    update: mocks.update,
    demoteOwner: mocks.demoteOwner,
    delete: mocks.delete,
  }),
}));

vi.mock("@calcom/features/organizations/di/OrganizationMoveService.container", () => ({
  getOrganizationMoveService: () => ({
    moveUser: mocks.moveUser,
    previewMoveTeam: mocks.previewMoveTeam,
    moveTeam: mocks.moveTeam,
    listTeams: mocks.listTeams,
  }),
}));

const ctx: TRPCContextInner = {
  prisma,
  insightsDb: readonlyPrisma,
  locale: "en",
  traceContext: { traceId: "trace_test", spanId: "span_test", operation: "test" },
};

const createCaller = createCallerFactory(organizationsRouter);

const organization = {
  id: 5,
  name: "Acme",
  slug: "acme",
  domain: "acme.example.com",
  isDefault: false,
  memberCount: 3,
  teamCount: 1,
  owners: [{ userId: 9, name: "Owner", email: "owner@acme.example.com" }],
};

const validCreateInput = {
  name: "Acme",
  slug: "acme",
  domain: "acme.example.com",
  owner: { userId: 9 },
};

const sessionFor = (role: "ADMIN" | "USER") => ({
  user: { id: 7, name: "Admin", role },
  session: { upId: "usr-7", expires: "2099-01-01T00:00:00.000Z", user: { id: 7 } },
});

const serviceMocks = () => [
  mocks.list,
  mocks.get,
  mocks.create,
  mocks.update,
  mocks.demoteOwner,
  mocks.delete,
  mocks.moveUser,
  mocks.previewMoveTeam,
  mocks.moveTeam,
  mocks.listTeams,
];

const validMoveTeamInput = { teamId: 11, toOrganizationId: 5, outsideMembers: "move" as const };

const callEveryProcedure = (caller: ReturnType<typeof createCaller>) => [
  caller.list({}),
  caller.get({ id: 5 }),
  caller.create(validCreateInput),
  caller.update({ id: 5, name: "Acme 2" }),
  caller.demoteOwner({ id: 5, userId: 9, role: "ADMIN" }),
  caller.delete({ id: 5 }),
  caller.moveUser({ userId: 9, toOrganizationId: 5 }),
  caller.previewMoveTeam({ teamId: 11, toOrganizationId: 5 }),
  caller.moveTeam(validMoveTeamInput),
  caller.listTeams({ organizationId: 5 }),
];

describe("admin organizations router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mocks.getUserSession.mockResolvedValue(sessionFor("ADMIN"));
    mocks.list.mockResolvedValue({ items: [], nextCursor: undefined });
    mocks.get.mockResolvedValue(organization);
    mocks.create.mockResolvedValue(organization);
    mocks.update.mockResolvedValue(organization);
    mocks.demoteOwner.mockResolvedValue(organization);
    mocks.delete.mockResolvedValue({ id: 5 });
    mocks.moveUser.mockResolvedValue({ userId: 9, organizationId: 5, username: "owner" });
    mocks.previewMoveTeam.mockResolvedValue({ membersOutsideTarget: [], slugTaken: false });
    mocks.moveTeam.mockResolvedValue({ teamId: 11, organizationId: 5, slug: "sales" });
    mocks.listTeams.mockResolvedValue({ items: [], nextCursor: undefined });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("access control", () => {
    it("rejects a non-admin on every procedure without calling the service", async () => {
      mocks.getUserSession.mockResolvedValue(sessionFor("USER"));

      for (const call of callEveryProcedure(createCaller(ctx))) {
        await expect(call).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      }
      for (const fn of serviceMocks()) expect(fn).not.toHaveBeenCalled();
    });

    it("rejects a request without a session", async () => {
      mocks.getUserSession.mockResolvedValue({ user: null, session: null });

      for (const call of callEveryProcedure(createCaller(ctx))) {
        await expect(call).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      }
      for (const fn of serviceMocks()) expect(fn).not.toHaveBeenCalled();
    });

    it("returns NOT_FOUND to an admin while the feature flag is off", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");

      for (const call of callEveryProcedure(createCaller(ctx))) {
        await expect(call).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      for (const fn of serviceMocks()) expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it.each([0, 101])("rejects list limit %s", async (limit) => {
      await expect(createCaller(ctx).list({ limit })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.list).not.toHaveBeenCalled();
    });

    it.each([0, -1])("rejects id %s", async (id) => {
      const caller = createCaller(ctx);

      await expect(caller.get({ id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller.update({ id, name: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller.delete({ id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
    });

    it("rejects update with ownerUserId 0", async () => {
      await expect(createCaller(ctx).update({ id: 5, ownerUserId: 0 })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it.each([
      ["an empty owner", { ...validCreateInput, owner: {} }],
      ["an owner with extra keys", { ...validCreateInput, owner: { userId: 1, email: "x" } }],
      ["an owner with both userId and email", { ...validCreateInput, owner: { userId: 1, email: "a@b.co" } }],
      ["an invalid owner email", { ...validCreateInput, owner: { email: "bad" } }],
      ["a missing domain", { name: "Acme", slug: "acme", owner: { userId: 9 } }],
      ["a name over 100 characters", { ...validCreateInput, name: "a".repeat(101) }],
    ])("rejects create with %s", async (_label, input) => {
      await expect(
        createCaller(ctx).create(input as Parameters<ReturnType<typeof createCaller>["create"]>[0])
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe("move input validation", () => {
    it.each([
      ["a negative user id", () => createCaller(ctx).moveUser({ userId: -1, toOrganizationId: 5 })],
      [
        "an empty newUsername",
        () => createCaller(ctx).moveUser({ userId: 9, toOrganizationId: 5, newUsername: "  " }),
      ],
      ["a zero team id", () => createCaller(ctx).previewMoveTeam({ teamId: 0, toOrganizationId: 5 })],
      [
        "an unknown outsideMembers mode",
        () =>
          createCaller(ctx).moveTeam({
            ...validMoveTeamInput,
            outsideMembers: "keep" as unknown as "move",
          }),
      ],
      [
        "a newSlug over 50 characters",
        () => createCaller(ctx).moveTeam({ ...validMoveTeamInput, newSlug: "a".repeat(51) }),
      ],
      [
        "an empty new username for a team member",
        () =>
          createCaller(ctx).moveTeam({
            ...validMoveTeamInput,
            newUsernames: [{ userId: 9, username: "  " }],
          }),
      ],
      ["a listTeams limit of 101", () => createCaller(ctx).listTeams({ organizationId: 5, limit: 101 })],
    ])("rejects %s", async (_label, call) => {
      await expect(call()).rejects.toMatchObject({ code: "BAD_REQUEST" });
      for (const fn of serviceMocks()) expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("move service wiring", () => {
    it("moves a user with the input and the acting admin id", async () => {
      const input = { userId: 9, toOrganizationId: 5, newUsername: "owner2" };

      await createCaller(ctx).moveUser(input);

      expect(mocks.moveUser).toHaveBeenCalledWith(input, 7);
    });

    it("previews a team move with the input", async () => {
      await createCaller(ctx).previewMoveTeam({ teamId: 11, toOrganizationId: 5 });

      expect(mocks.previewMoveTeam).toHaveBeenCalledWith({ teamId: 11, toOrganizationId: 5 });
    });

    it("moves a team with the input and the acting admin id", async () => {
      const input = { ...validMoveTeamInput, newSlug: "sales-2" };

      await expect(createCaller(ctx).moveTeam(input)).resolves.toEqual({
        teamId: 11,
        organizationId: 5,
        slug: "sales",
      });
      expect(mocks.moveTeam).toHaveBeenCalledWith(input, 7);
    });

    it("passes per-member new usernames through to the team move", async () => {
      const input = { ...validMoveTeamInput, newUsernames: [{ userId: 9, username: "owner2" }] };

      await createCaller(ctx).moveTeam(input);

      expect(mocks.moveTeam).toHaveBeenCalledWith(input, 7);
    });

    it("lists teams with the acting admin id", async () => {
      await createCaller(ctx).listTeams({ organizationId: 5, search: "sal", limit: 20 });

      expect(mocks.listTeams).toHaveBeenCalledWith({
        organizationId: 5,
        search: "sal",
        limit: 20,
        actorUserId: 7,
      });
    });

    it("maps a move Conflict to CONFLICT with its message", async () => {
      const message = "username_taken_in_target_organization";
      mocks.moveUser.mockRejectedValue(ErrorWithCode.Factory.Conflict(message));

      await expect(createCaller(ctx).moveUser({ userId: 9, toOrganizationId: 5 })).rejects.toMatchObject({
        code: "CONFLICT",
        message,
      });
    });
  });

  describe("service wiring", () => {
    it("passes list params through", async () => {
      const params = { search: "acme", cursor: 3, limit: 20 };

      await createCaller(ctx).list(params);

      expect(mocks.list).toHaveBeenCalledWith(params);
    });

    it("gets by id", async () => {
      await expect(createCaller(ctx).get({ id: 5 })).resolves.toEqual(organization);
      expect(mocks.get).toHaveBeenCalledWith(5);
    });

    it("creates with the input and the acting admin id and name", async () => {
      const input = { ...validCreateInput, confirmMoveOwner: true };

      await createCaller(ctx).create(input);

      expect(mocks.create).toHaveBeenCalledWith(input, 7, "Admin");
    });

    it("trims and lowercases an owner email before it reaches the service", async () => {
      await createCaller(ctx).create({ ...validCreateInput, owner: { email: " Jane@Acme.COM " } });

      expect(mocks.create).toHaveBeenCalledWith(
        { ...validCreateInput, owner: { email: "jane@acme.com" } },
        7,
        "Admin"
      );
    });

    it("updates with the id, the remaining fields and the acting admin id", async () => {
      await createCaller(ctx).update({ id: 5, name: "Acme 2", domain: "acme2.example.com" });

      expect(mocks.update).toHaveBeenCalledWith(5, { name: "Acme 2", domain: "acme2.example.com" }, 7);
    });

    it("forwards ownerUserId on update", async () => {
      await createCaller(ctx).update({ id: 5, ownerUserId: 9 });

      expect(mocks.update).toHaveBeenCalledWith(5, { ownerUserId: 9 }, 7);
    });

    it("demotes an owner with the id, the user, the role and the acting admin id", async () => {
      await expect(createCaller(ctx).demoteOwner({ id: 5, userId: 9, role: "MEMBER" })).resolves.toEqual(
        organization
      );

      expect(mocks.demoteOwner).toHaveBeenCalledWith(5, { userId: 9, role: "MEMBER" }, 7);
    });

    it("rejects demoting an owner to OWNER", async () => {
      await expect(
        // @ts-expect-error OWNER is not a valid demotion target
        createCaller(ctx).demoteOwner({ id: 5, userId: 9, role: "OWNER" })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.demoteOwner).not.toHaveBeenCalled();
    });

    it("maps a refused last-owner demotion to PRECONDITION_FAILED with its key", async () => {
      mocks.demoteOwner.mockRejectedValue(
        ErrorWithCode.Factory.PreconditionFailed("organization_must_keep_one_owner")
      );

      await expect(createCaller(ctx).demoteOwner({ id: 5, userId: 9, role: "ADMIN" })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "organization_must_keep_one_owner",
      });
    });

    it("deletes with the id and the acting admin id", async () => {
      await expect(createCaller(ctx).delete({ id: 5 })).resolves.toEqual({ id: 5 });
      expect(mocks.delete).toHaveBeenCalledWith(5, 7);
    });
  });

  describe("error mapping", () => {
    it.each([
      ["Conflict", "CONFLICT", "Slug already taken"],
      ["PreconditionFailed", "PRECONDITION_FAILED", "Owner belongs to another organization"],
      ["NotFound", "NOT_FOUND", "organization_not_found"],
      ["BadRequest", "BAD_REQUEST", "Invalid domain"],
    ] as const)("maps ErrorWithCode %s to %s with its message", async (factory, code, message) => {
      mocks.create.mockRejectedValue(ErrorWithCode.Factory[factory](message));

      await expect(createCaller(ctx).create(validCreateInput)).rejects.toMatchObject({ code, message });
    });
  });

  describe("output", () => {
    it("strips fields that are not part of the DTO", async () => {
      mocks.get.mockResolvedValue({ ...organization, internalNote: "secret" });

      const result = await createCaller(ctx).get({ id: 5 });

      expect(result).toEqual(organization);
      expect(result).not.toHaveProperty("internalNote");
    });

    it("strips fields that are not part of the DTO from create", async () => {
      mocks.create.mockResolvedValue({ ...organization, internalNote: "secret" });

      const result = await createCaller(ctx).create(validCreateInput);

      expect(result).toEqual(organization);
      expect(result).not.toHaveProperty("internalNote");
    });
  });
});
