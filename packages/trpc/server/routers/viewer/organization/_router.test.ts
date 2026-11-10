import { ErrorWithCode } from "@calcom/lib/errors";
import prisma, { readonlyPrisma } from "@calcom/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TRPCContextInner } from "../../../createContext";
import { createCallerFactory } from "../../../trpc";
import { organizationRouter } from "./_router";

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  getForMember: vi.fn(),
  updateName: vi.fn(),
  listMembers: vi.fn(),
  inviteMember: vi.fn(),
  setRole: vi.fn(),
  removeMember: vi.fn(),
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
  getOrganizationService: () => ({ getForMember: mocks.getForMember, updateName: mocks.updateName }),
}));

vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({
    listMembers: mocks.listMembers,
    inviteMember: mocks.inviteMember,
    setRole: mocks.setRole,
    removeMember: mocks.removeMember,
    listTeams: mocks.listTeams,
  }),
}));

const ctx: TRPCContextInner = {
  prisma,
  insightsDb: readonlyPrisma,
  locale: "en",
  traceContext: { traceId: "trace_test", spanId: "span_test", operation: "test" },
};

const createCaller = createCallerFactory(organizationRouter);

const currentOrganization = {
  id: 5,
  name: "Acme",
  slug: "acme",
  domain: "acme.example.com",
  isDefault: false,
  owners: [{ userId: 9, name: "Owner", email: "owner@acme.example.com" }],
  viewerRole: "ADMIN" as const,
};

const member = {
  userId: 11,
  name: "Member",
  email: "member@acme.example.com",
  username: "member",
  role: "MEMBER" as const,
  accepted: true,
};

const team = { teamId: 21, name: "Sales", slug: "sales", memberCount: 2, viewerIsMember: true };

const sessionFor = (overrides: { organizationId?: number | null; name?: string | null } = {}) => ({
  user: {
    id: 7,
    role: "USER",
    name: "Alice",
    email: "alice@acme.example.com",
    organizationId: 5,
    ...overrides,
  },
  session: { upId: "usr-7", expires: "2099-01-01T00:00:00.000Z", user: { id: 7 } },
});

const serviceMocks = () => [
  mocks.getForMember,
  mocks.updateName,
  mocks.listMembers,
  mocks.inviteMember,
  mocks.setRole,
  mocks.removeMember,
  mocks.listTeams,
];

const callEveryProcedure = (caller: ReturnType<typeof createCaller>) => [
  caller.current(),
  caller.updateName({ name: "Acme Inc" }),
  caller.listMembers({}),
  caller.inviteMember({ email: "new@acme.example.com", role: "MEMBER" }),
  caller.updateRole({ userId: 11, role: "ADMIN" }),
  caller.removeMember({ userId: 11 }),
  caller.listTeams({}),
];

describe("viewer organization router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mocks.getUserSession.mockResolvedValue(sessionFor());
    mocks.getForMember.mockResolvedValue(currentOrganization);
    mocks.listMembers.mockResolvedValue({ items: [member], nextCursor: undefined });
    mocks.inviteMember.mockResolvedValue({ invited: true });
    mocks.updateName.mockResolvedValue({
      id: 5,
      name: "Acme Inc",
      slug: "acme",
      domain: "acme.example.com",
      isDefault: false,
      memberCount: 3,
      teamCount: 1,
      owners: [{ userId: 9, name: "Owner", email: "owner@acme.example.com" }],
    });
    mocks.setRole.mockResolvedValue({ userId: 11, role: "ADMIN" });
    mocks.removeMember.mockResolvedValue({ userId: 11 });
    mocks.listTeams.mockResolvedValue({ items: [team], nextCursor: undefined });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("access control", () => {
    it("returns NOT_FOUND on every procedure while the feature flag is off", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");

      for (const call of callEveryProcedure(createCaller(ctx))) {
        await expect(call).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      for (const fn of serviceMocks()) expect(fn).not.toHaveBeenCalled();
    });

    it("returns NOT_FOUND on every procedure to a user without an organization", async () => {
      mocks.getUserSession.mockResolvedValue(sessionFor({ organizationId: null }));

      for (const call of callEveryProcedure(createCaller(ctx))) {
        await expect(call).rejects.toMatchObject({ code: "NOT_FOUND" });
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
  });

  describe("input validation", () => {
    it.each(["not-an-email", "", `${"a".repeat(250)}@x.io`])("rejects invite email %j", async (email) => {
      await expect(createCaller(ctx).inviteMember({ email, role: "MEMBER" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.inviteMember).not.toHaveBeenCalled();
    });

    it("rejects an unknown role", async () => {
      const caller = createCaller(ctx);
      const role = "SUPERUSER" as unknown as "MEMBER";

      await expect(caller.inviteMember({ email: "new@acme.example.com", role })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      await expect(caller.updateRole({ userId: 11, role })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.inviteMember).not.toHaveBeenCalled();
      expect(mocks.setRole).not.toHaveBeenCalled();
    });

    it.each([0, -1])("rejects userId %s", async (userId) => {
      const caller = createCaller(ctx);

      await expect(caller.updateRole({ userId, role: "ADMIN" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      await expect(caller.removeMember({ userId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.setRole).not.toHaveBeenCalled();
      expect(mocks.removeMember).not.toHaveBeenCalled();
    });

    it("rejects a whitespace-only newUsername", async () => {
      await expect(createCaller(ctx).removeMember({ userId: 11, newUsername: "   " })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.removeMember).not.toHaveBeenCalled();
    });

    it("rejects a name over 100 characters", async () => {
      await expect(createCaller(ctx).updateName({ name: "a".repeat(101) })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.updateName).not.toHaveBeenCalled();
    });

    it.each([0, 101])("rejects list limit %s", async (limit) => {
      const caller = createCaller(ctx);

      await expect(caller.listMembers({ limit })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller.listTeams({ limit })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.listMembers).not.toHaveBeenCalled();
      expect(mocks.listTeams).not.toHaveBeenCalled();
    });
  });

  describe("service wiring", () => {
    it("loads the current organization for the session's org and user", async () => {
      await expect(createCaller(ctx).current()).resolves.toEqual(currentOrganization);
      expect(mocks.getForMember).toHaveBeenCalledWith({ organizationId: 5, viewerUserId: 7 });
    });

    it("renames the session's organization", async () => {
      await expect(createCaller(ctx).updateName({ name: "Acme Inc" })).resolves.toMatchObject({
        id: 5,
        name: "Acme Inc",
      });
      expect(mocks.updateName).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        name: "Acme Inc",
      });
    });

    it("lists members with the session's org and user and the list params", async () => {
      await createCaller(ctx).listMembers({ search: "mem", cursor: 3, limit: 20 });

      expect(mocks.listMembers).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        search: "mem",
        cursor: 3,
        limit: 20,
      });
    });

    it("lists teams with the session's org and user and the list params", async () => {
      await expect(createCaller(ctx).listTeams({ search: "sal" })).resolves.toEqual({ items: [team] });
      expect(mocks.listTeams).toHaveBeenCalledWith({ organizationId: 5, actorUserId: 7, search: "sal" });
    });

    it("invites with a normalized email and the actor's name", async () => {
      await expect(
        createCaller(ctx).inviteMember({ email: "  New@Acme.Example.com ", role: "ADMIN" })
      ).resolves.toEqual({ invited: true });
      expect(mocks.inviteMember).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        actorName: "Alice",
        email: "new@acme.example.com",
        role: "ADMIN",
      });
    });

    it("falls back to the actor's email when they have no name", async () => {
      mocks.getUserSession.mockResolvedValue(sessionFor({ name: null }));

      await createCaller(ctx).inviteMember({ email: "new@acme.example.com", role: "MEMBER" });

      expect(mocks.inviteMember).toHaveBeenCalledWith(
        expect.objectContaining({ actorName: "alice@acme.example.com" })
      );
    });

    it("updates a role through setRole", async () => {
      await expect(createCaller(ctx).updateRole({ userId: 11, role: "ADMIN" })).resolves.toEqual({
        userId: 11,
        role: "ADMIN",
      });
      expect(mocks.setRole).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        userId: 11,
        role: "ADMIN",
      });
    });

    it("removes a member", async () => {
      await expect(createCaller(ctx).removeMember({ userId: 11 })).resolves.toEqual({ userId: 11 });
      expect(mocks.removeMember).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        userId: 11,
        newUsername: undefined,
      });
    });

    it("passes a trimmed newUsername to the service", async () => {
      await createCaller(ctx).removeMember({ userId: 11, newUsername: " jane-new " });
      expect(mocks.removeMember).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        userId: 11,
        newUsername: "jane-new",
      });
    });

    it("ignores an organizationId sent in the input", async () => {
      const caller = createCaller(ctx);
      const foreign = { organizationId: 99 };

      await caller.listMembers({ ...foreign } as Parameters<typeof caller.listMembers>[0]);
      await caller.updateName({ name: "Acme Inc", ...foreign } as Parameters<typeof caller.updateName>[0]);
      await caller.listTeams({ ...foreign } as Parameters<typeof caller.listTeams>[0]);
      await caller.inviteMember({
        email: "new@acme.example.com",
        role: "MEMBER",
        ...foreign,
      } as Parameters<typeof caller.inviteMember>[0]);
      await caller.updateRole({ userId: 11, role: "ADMIN", ...foreign } as Parameters<
        typeof caller.updateRole
      >[0]);
      await caller.removeMember({ userId: 11, ...foreign } as Parameters<typeof caller.removeMember>[0]);

      for (const fn of [
        mocks.listMembers,
        mocks.listTeams,
        mocks.inviteMember,
        mocks.setRole,
        mocks.removeMember,
        mocks.updateName,
      ]) {
        expect(fn).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 5, actorUserId: 7 }));
        expect(fn).not.toHaveBeenCalledWith(expect.objectContaining({ organizationId: 99 }));
      }
    });
  });

  describe("error mapping", () => {
    it.each([
      ["Forbidden", "FORBIDDEN", "organization_only_owners_can_manage_owner_role"],
      ["Conflict", "CONFLICT", "user_belongs_to_another_organization"],
      ["PreconditionFailed", "PRECONDITION_FAILED", "An organization needs at least one owner"],
      ["NotFound", "NOT_FOUND", "organization_member_not_found"],
    ] as const)("maps ErrorWithCode %s to %s with its message", async (factory, code, message) => {
      mocks.setRole.mockRejectedValue(ErrorWithCode.Factory[factory](message));

      await expect(createCaller(ctx).updateRole({ userId: 11, role: "OWNER" })).rejects.toMatchObject({
        code,
        message,
      });
    });

    it("maps a Conflict from inviteMember", async () => {
      mocks.inviteMember.mockRejectedValue(ErrorWithCode.Factory.Conflict("user_is_already_a_member"));

      await expect(
        createCaller(ctx).inviteMember({ email: "new@acme.example.com", role: "MEMBER" })
      ).rejects.toMatchObject({ code: "CONFLICT", message: "user_is_already_a_member" });
    });

    it("maps a Forbidden from updateName", async () => {
      mocks.updateName.mockRejectedValue(
        ErrorWithCode.Factory.Forbidden("organization_only_managers_can_update_organization")
      );

      await expect(createCaller(ctx).updateName({ name: "Acme Inc" })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "organization_only_managers_can_update_organization",
      });
    });

    it("maps a NotFound from current", async () => {
      mocks.getForMember.mockRejectedValue(ErrorWithCode.Factory.NotFound("organization_not_found"));

      await expect(createCaller(ctx).current()).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("output", () => {
    it("strips fields that are not part of the member DTO", async () => {
      mocks.listMembers.mockResolvedValue({ items: [{ ...member, password: "hash" }] });

      const result = await createCaller(ctx).listMembers({});

      expect(result.items[0]).toEqual(member);
      expect(result.items[0]).not.toHaveProperty("password");
    });
  });
});
