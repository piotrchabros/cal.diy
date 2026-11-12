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
  updateLogo: vi.fn(),
  listMembers: vi.fn(),
  inviteMember: vi.fn(),
  setRole: vi.fn(),
  removeMember: vi.fn(),
  listTeams: vi.fn(),
  getNotetakerSettings: vi.fn(),
  updateNotetakerSettings: vi.fn(),
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
    getForMember: mocks.getForMember,
    updateName: mocks.updateName,
    updateLogo: mocks.updateLogo,
  }),
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

vi.mock("@calcom/features/notetaker/di/OrganizationNotetakerSettingsService.container", () => ({
  getOrganizationNotetakerSettingsService: () => ({
    get: mocks.getNotetakerSettings,
    update: mocks.updateNotetakerSettings,
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
  logoUrl: null,
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

const notetakerSettings = {
  botName: "Acme Scribe",
  botImageDataUrl: null,
  fallbackBotName: "Notetaker",
  canEdit: true,
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
  mocks.updateLogo,
  mocks.listMembers,
  mocks.inviteMember,
  mocks.setRole,
  mocks.removeMember,
  mocks.listTeams,
  mocks.getNotetakerSettings,
  mocks.updateNotetakerSettings,
];

const callEveryProcedure = (caller: ReturnType<typeof createCaller>) => [
  caller.current(),
  caller.updateName({ name: "Acme Inc" }),
  caller.updateLogo({ logo: null }),
  caller.listMembers({}),
  caller.inviteMember({ email: "new@acme.example.com", role: "MEMBER" }),
  caller.updateRole({ userId: 11, role: "ADMIN" }),
  caller.removeMember({ userId: 11 }),
  caller.listTeams({}),
  caller.notetakerSettings(),
  caller.updateNotetakerSettings({ botName: "Acme Scribe" }),
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
      logoUrl: null,
      owners: [{ userId: 9, name: "Owner", email: "owner@acme.example.com" }],
    });
    mocks.updateLogo.mockResolvedValue({
      id: 5,
      name: "Acme",
      slug: "acme",
      domain: "acme.example.com",
      isDefault: false,
      memberCount: 3,
      teamCount: 1,
      logoUrl: "/api/avatar/logo.png",
      owners: [{ userId: 9, name: "Owner", email: "owner@acme.example.com" }],
    });
    mocks.setRole.mockResolvedValue({ userId: 11, role: "ADMIN" });
    mocks.removeMember.mockResolvedValue({ userId: 11 });
    mocks.listTeams.mockResolvedValue({ items: [team], nextCursor: undefined });
    mocks.getNotetakerSettings.mockResolvedValue(notetakerSettings);
    mocks.updateNotetakerSettings.mockResolvedValue(notetakerSettings);
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

    it("rejects a logo over 8,000,000 characters", async () => {
      await expect(createCaller(ctx).updateLogo({ logo: "a".repeat(8_000_001) })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.updateLogo).not.toHaveBeenCalled();
    });

    it("rejects an updateLogo call without a logo field", async () => {
      const caller = createCaller(ctx);
      await expect(caller.updateLogo({} as Parameters<typeof caller.updateLogo>[0])).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.updateLogo).not.toHaveBeenCalled();
    });

    it("rejects a notetaker settings update without any field", async () => {
      await expect(createCaller(ctx).updateNotetakerSettings({})).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.updateNotetakerSettings).not.toHaveBeenCalled();
    });

    it.each([
      ["a bot name over 200 characters", { botName: "a".repeat(201) }],
      ["a bot image over 1,000,000 characters", { botImage: "a".repeat(1_000_001) }],
    ])("rejects %s", async (_, input) => {
      await expect(createCaller(ctx).updateNotetakerSettings(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.updateNotetakerSettings).not.toHaveBeenCalled();
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

    it("updates the session's organization logo", async () => {
      await expect(
        createCaller(ctx).updateLogo({ logo: "data:image/png;base64,AAAA" })
      ).resolves.toMatchObject({
        id: 5,
        logoUrl: "/api/avatar/logo.png",
      });
      expect(mocks.updateLogo).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        logo: "data:image/png;base64,AAAA",
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

    it("loads the notetaker settings for the session's org and user", async () => {
      await expect(createCaller(ctx).notetakerSettings()).resolves.toEqual(notetakerSettings);
      expect(mocks.getNotetakerSettings).toHaveBeenCalledWith({ organizationId: 5, viewerUserId: 7 });
    });

    it("updates the notetaker settings of the session's organization", async () => {
      const botImage = "data:image/png;base64,iVBORw0KGgo=";

      const caller = createCaller(ctx);

      await expect(
        caller.updateNotetakerSettings({ botName: "Acme Scribe", botImage, organizationId: 99 } as Parameters<
          typeof caller.updateNotetakerSettings
        >[0])
      ).resolves.toEqual(notetakerSettings);
      expect(mocks.updateNotetakerSettings).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        botName: "Acme Scribe",
        botImage,
      });
    });

    it("passes null to clear the notetaker name and image", async () => {
      await createCaller(ctx).updateNotetakerSettings({ botName: null, botImage: null });

      expect(mocks.updateNotetakerSettings).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        botName: null,
        botImage: null,
      });
    });

    it("leaves an omitted notetaker field undefined", async () => {
      await createCaller(ctx).updateNotetakerSettings({ botImage: null });

      expect(mocks.updateNotetakerSettings).toHaveBeenCalledWith({
        organizationId: 5,
        actorUserId: 7,
        botName: undefined,
        botImage: null,
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

    it("maps a BadRequest from updateLogo", async () => {
      mocks.updateLogo.mockRejectedValue(ErrorWithCode.Factory.BadRequest("organization_logo_invalid"));

      await expect(createCaller(ctx).updateLogo({ logo: "nope" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "organization_logo_invalid",
      });
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

    it.each([
      ["BadRequest", "BAD_REQUEST", "notetaker_bot_image_too_large"],
      ["Forbidden", "FORBIDDEN", "organization_only_managers_can_update_organization"],
    ] as const)("maps ErrorWithCode %s from updateNotetakerSettings to %s", async (factory, code, message) => {
      mocks.updateNotetakerSettings.mockRejectedValue(ErrorWithCode.Factory[factory](message));

      await expect(
        createCaller(ctx).updateNotetakerSettings({ botName: "Acme Scribe" })
      ).rejects.toMatchObject({
        code,
        message,
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

    it("strips fields that are not part of the notetaker settings DTO", async () => {
      mocks.getNotetakerSettings.mockResolvedValue({ ...notetakerSettings, organizationId: 5 });

      await expect(createCaller(ctx).notetakerSettings()).resolves.toEqual(notetakerSettings);
    });
  });
});
