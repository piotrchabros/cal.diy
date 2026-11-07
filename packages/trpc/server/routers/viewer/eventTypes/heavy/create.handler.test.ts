import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import { Prisma } from "@calcom/prisma/client";
import { MembershipRole, SchedulingType } from "@calcom/prisma/enums";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "./create.handler";

const { createEventType, findUniqueByUserIdAndTeamId, findTeamIdsByAcceptedRole } = vi.hoisted(() => ({
  createEventType: vi.fn(),
  findUniqueByUserIdAndTeamId: vi.fn(),
  findTeamIdsByAcceptedRole: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({
  default: prismaMock,
}));
vi.mock("@calcom/features/eventtypes/repositories/eventTypeRepository", () => ({
  EventTypeRepository: class {
    create = createEventType;
  },
}));
vi.mock("@calcom/features/membership/repositories/MembershipRepository", () => ({
  MembershipRepository: class {
    findUniqueByUserIdAndTeamId = findUniqueByUserIdAndTeamId;
    findTeamIdsByAcceptedRole = findTeamIdsByAcceptedRole;
  },
}));
vi.mock("@calcom/app-store/_utils/getDefaultLocations", () => ({
  getDefaultLocations: async () => [{ type: "integrations:daily" }],
}));

const USER_ID = 7;
const TEAM_ID = 42;

type HandlerOptions = Parameters<typeof createHandler>[0];

function buildCtx(role: HandlerOptions["ctx"]["user"]["role"] = "USER"): HandlerOptions["ctx"] {
  return {
    user: {
      id: USER_ID,
      role,
      organizationId: null,
      organization: { isOrgAdmin: false },
      profile: { id: null },
      metadata: null,
      email: "creator@example.com",
    },
    prisma: prismaMock,
  };
}

const baseInput = { title: "Team sync", slug: "team-sync", length: 30 };

function teamInput(schedulingType: SchedulingType): HandlerOptions["input"] {
  return { ...baseInput, teamId: TEAM_ID, schedulingType };
}

function membership(role: MembershipRole, accepted = true) {
  return { id: 1, userId: USER_ID, teamId: TEAM_ID, role, accepted };
}

type Membership = ReturnType<typeof membership>;

let fixture: { membership: Membership | null; isParentOrgAdmin: boolean };

function givenMembership(value: Membership | null, { isParentOrgAdmin = false } = {}) {
  fixture = { membership: value, isParentOrgAdmin };
}

// Mirrors the repository query: a direct accepted membership with one of teamRoles, or an accepted
// admin/owner membership in the parent organization when parentRoles are requested.
function findTeamIdsByAcceptedRoleFromFixture({
  teamId,
  teamRoles,
  parentRoles,
}: {
  teamId?: number;
  teamRoles: readonly MembershipRole[];
  parentRoles: readonly MembershipRole[];
}) {
  const hasTeamRole = !!fixture.membership?.accepted && teamRoles.includes(fixture.membership.role);
  const hasParentRole = parentRoles.length > 0 && fixture.isParentOrgAdmin;
  return Promise.resolve(hasTeamRole || hasParentRole ? [teamId ?? TEAM_ID] : []);
}

beforeEach(() => {
  vi.resetAllMocks();
  givenMembership(null);
  createEventType.mockResolvedValue({ id: 1 });
  findUniqueByUserIdAndTeamId.mockImplementation(() => Promise.resolve(fixture.membership));
  findTeamIdsByAcceptedRole.mockImplementation(findTeamIdsByAcceptedRoleFromFixture);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("createHandler with organizations disabled", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("makes a team OWNER the fixed host of a COLLECTIVE event type", async () => {
    givenMembership(membership(MembershipRole.OWNER));

    const result = await createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.COLLECTIVE) });

    expect(result).toEqual({ eventType: { id: 1 } });
    expect(findUniqueByUserIdAndTeamId).toHaveBeenCalledWith({ userId: USER_ID, teamId: TEAM_ID });
    expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, teamId: TEAM_ID, parentRoles: [] })
    );
    expect(createEventType).toHaveBeenCalledTimes(1);
    const data = createEventType.mock.calls[0][0];
    expect(data.team).toEqual({ connect: { id: TEAM_ID } });
    expect(data.schedulingType).toBe(SchedulingType.COLLECTIVE);
    expect(data.hosts).toEqual({
      create: [{ userId: USER_ID, isFixed: true, priority: 2, weight: 100 }],
    });
    expect(data.users).toBeUndefined();
    expect(data.owner).toBeUndefined();
  });

  it("makes a team ADMIN a non-fixed host of a ROUND_ROBIN event type", async () => {
    givenMembership(membership(MembershipRole.ADMIN));

    await createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.ROUND_ROBIN) });

    const data = createEventType.mock.calls[0][0];
    expect(data.schedulingType).toBe(SchedulingType.ROUND_ROBIN);
    expect(data.hosts).toEqual({
      create: [{ userId: USER_ID, isFixed: false, priority: 2, weight: 100 }],
    });
  });

  it("rejects a team MEMBER with UNAUTHORIZED", async () => {
    givenMembership(membership(MembershipRole.MEMBER));

    await expect(
      createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.COLLECTIVE) })
    ).rejects.toThrow(new TRPCError({ code: "UNAUTHORIZED" }));
    expect(createEventType).not.toHaveBeenCalled();
  });

  it("rejects a user without membership with UNAUTHORIZED", async () => {
    givenMembership(null);

    await expect(
      createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.COLLECTIVE) })
    ).rejects.toThrow(new TRPCError({ code: "UNAUTHORIZED" }));
    expect(createEventType).not.toHaveBeenCalled();
  });

  it("rejects an OWNER whose membership is not accepted with UNAUTHORIZED", async () => {
    givenMembership(membership(MembershipRole.OWNER, false));

    await expect(
      createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.COLLECTIVE) })
    ).rejects.toThrow(new TRPCError({ code: "UNAUTHORIZED" }));
    expect(createEventType).not.toHaveBeenCalled();
  });

  it("lets a system admin without membership create the event type without a host", async () => {
    givenMembership(null);

    await createHandler({ ctx: buildCtx("ADMIN"), input: teamInput(SchedulingType.COLLECTIVE) });

    expect(createEventType).toHaveBeenCalledTimes(1);
    const data = createEventType.mock.calls[0][0];
    expect(data.team).toEqual({ connect: { id: TEAM_ID } });
    expect(data).not.toHaveProperty("hosts");
  });

  it("creates a MANAGED event type for an OWNER without a host", async () => {
    givenMembership(membership(MembershipRole.OWNER));

    await createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.MANAGED) });

    expect(createEventType).toHaveBeenCalledTimes(1);
    const data = createEventType.mock.calls[0][0];
    expect(data.schedulingType).toBe(SchedulingType.MANAGED);
    expect(data).not.toHaveProperty("hosts");
  });

  it("connects the user as owner and user of a personal event type", async () => {
    await createHandler({ ctx: buildCtx(), input: baseInput });

    expect(findUniqueByUserIdAndTeamId).not.toHaveBeenCalled();
    expect(findTeamIdsByAcceptedRole).not.toHaveBeenCalled();
    const data = createEventType.mock.calls[0][0];
    expect(data.owner).toEqual({ connect: { id: USER_ID } });
    expect(data.users).toEqual({ connect: { id: USER_ID } });
    expect(data).not.toHaveProperty("team");
    expect(data).not.toHaveProperty("hosts");
  });

  it("maps a slug unique constraint violation to BAD_REQUEST", async () => {
    createEventType.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "mockedVersion",
        meta: { target: ["userId", "slug"] },
      })
    );

    await expect(createHandler({ ctx: buildCtx(), input: baseInput })).rejects.toThrow(
      new TRPCError({ code: "BAD_REQUEST", message: "URL Slug already exists for given user." })
    );
  });

  it("rejects a parent-org admin without team membership with UNAUTHORIZED", async () => {
    givenMembership(null, { isParentOrgAdmin: true });

    await expect(
      createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.COLLECTIVE) })
    ).rejects.toThrow(new TRPCError({ code: "UNAUTHORIZED" }));
    expect(createEventType).not.toHaveBeenCalled();
  });
});

describe("createHandler with organizations enabled", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lets a parent-org admin without team membership create the event type without a host", async () => {
    givenMembership(null, { isParentOrgAdmin: true });

    const result = await createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.COLLECTIVE) });

    expect(result).toEqual({ eventType: { id: 1 } });
    expect(findTeamIdsByAcceptedRole).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        teamId: TEAM_ID,
        teamRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
        parentRoles: [MembershipRole.ADMIN, MembershipRole.OWNER],
      })
    );
    const data = createEventType.mock.calls[0][0];
    expect(data.team).toEqual({ connect: { id: TEAM_ID } });
    expect(data).not.toHaveProperty("hosts");
  });

  it("makes a parent-org admin who is an accepted team MEMBER the host of a COLLECTIVE event type", async () => {
    givenMembership(membership(MembershipRole.MEMBER), { isParentOrgAdmin: true });

    await createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.COLLECTIVE) });

    const data = createEventType.mock.calls[0][0];
    expect(data.hosts).toEqual({
      create: [{ userId: USER_ID, isFixed: true, priority: 2, weight: 100 }],
    });
  });

  it("does not trust the unscoped session isOrgAdmin flag", async () => {
    givenMembership(null);
    const ctx = buildCtx();
    ctx.user.organization.isOrgAdmin = true;

    await expect(createHandler({ ctx, input: teamInput(SchedulingType.COLLECTIVE) })).rejects.toThrow(
      new TRPCError({ code: "UNAUTHORIZED" })
    );
    expect(createEventType).not.toHaveBeenCalled();
  });

  it("lets a team OWNER create the event type as host", async () => {
    givenMembership(membership(MembershipRole.OWNER));

    await createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.ROUND_ROBIN) });

    const data = createEventType.mock.calls[0][0];
    expect(data.hosts).toEqual({
      create: [{ userId: USER_ID, isFixed: false, priority: 2, weight: 100 }],
    });
  });

  it("rejects a team MEMBER who is not a parent-org admin with UNAUTHORIZED", async () => {
    givenMembership(membership(MembershipRole.MEMBER));

    await expect(
      createHandler({ ctx: buildCtx(), input: teamInput(SchedulingType.COLLECTIVE) })
    ).rejects.toThrow(new TRPCError({ code: "UNAUTHORIZED" }));
    expect(createEventType).not.toHaveBeenCalled();
  });
});
