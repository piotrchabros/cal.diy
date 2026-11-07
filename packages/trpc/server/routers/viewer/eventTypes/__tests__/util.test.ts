import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { authedProcedure } from "../../../procedures/authedProcedure";
import { createEventPbacProcedure, ensureEmailOrPhoneNumberIsPresent, eventOwnerProcedure } from "../util";

describe("createEventPbacProcedure", () => {
  const mockPrisma = {
    eventType: {
      findUnique: vi.fn(),
    },
  } as unknown as PrismaClient;

  const mockCtx = {
    user: { id: 1, organizationId: 100, profile: { upId: "user-1" } },
    session: { user: { id: 1 } },
    prisma: mockPrisma,
  };

  const mockNext = vi.fn().mockResolvedValue({ ctx: mockCtx });

  const otherOrgPersonalEvent = {
    id: 1,
    userId: 2,
    teamId: null,
    users: [{ id: 2 }],
    team: null,
    owner: { organizationId: 200 },
  };

  // Helper to get the custom middleware (after authedProcedure)
  const getMiddleware = (procedure: ReturnType<typeof authedProcedure>) => {
    // The last middleware is our custom one
    return procedure._def.middlewares[procedure._def.middlewares.length - 1];
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("personal events", () => {
    const personalEvent = {
      id: 1,
      userId: 1,
      teamId: null,
      users: [{ id: 1 }],
      team: null,
    };

    it("should allow owner to access their personal event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(personalEvent);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 1 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });

    it("should allow assigned user to access personal event", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue({ ...personalEvent, userId: 2, users: [{ id: 1 }, { id: 2 }] });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 1 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });

    it("should deny non-owner/non-assigned user from accessing personal event", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue({ ...personalEvent, userId: 2, users: [{ id: 2 }] });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 1 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).rejects.toThrow(TRPCError);
    });

    it("should deny team member from accessing another user's personal event", async () => {
      // User 1 trying to access user 2's personal event
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue({ ...personalEvent, userId: 2, users: [{ id: 2 }] });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      const result = middleware({
        ctx: mockCtx,
        input: { id: 1 },
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

      await expect(result).rejects.toThrow(TRPCError);
      await expect(result).rejects.toThrow("Permission required: eventType.update");
    });

    it("should only allow assigning self to personal event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(personalEvent);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 1, users: [1] },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });

    it("should deny assigning other users to personal event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(personalEvent);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      const result = middleware({
        ctx: mockCtx,
        input: { id: 1, users: [1, 2] },
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

      await expect(result).rejects.toThrow(TRPCError);
      await expect(result).rejects.toThrow("Cannot assign event to users outside of team membership");
    });
  });

  describe("team events - with permission", () => {
    const teamEvent = {
      id: 2,
      userId: null,
      teamId: 10,
      users: [],
      team: {
        members: [
          { userId: 1, accepted: true, role: MembershipRole.ADMIN },
          { userId: 2, accepted: true, role: MembershipRole.MEMBER },
          { userId: 3, accepted: true, role: MembershipRole.MEMBER },
        ],
        parent: null,
      },
    };

    it("should allow team member with permission to access team event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      const procedure = createEventPbacProcedure("eventType.update", [
        MembershipRole.ADMIN,
        MembershipRole.OWNER,
      ]);
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 2 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });

    it("should allow org admin without team membership to access team event", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue({
        ...teamEvent,
        team: {
          members: [{ userId: 2, accepted: true, role: MembershipRole.MEMBER }],
          parent: { members: [{ userId: 1 }] },
        },
      });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 2 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
      vi.unstubAllEnvs();
    });
  });

  describe("team events - user assignment validation", () => {
    const teamEvent = {
      id: 2,
      userId: null,
      teamId: 10,
      users: [],
      team: {
        members: [
          { userId: 1, accepted: true, role: MembershipRole.ADMIN },
          { userId: 2, accepted: true, role: MembershipRole.MEMBER },
          { userId: 3, accepted: true, role: MembershipRole.MEMBER },
        ],
        parent: null,
      },
    };

    it("should allow assigning team members to team event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 2, users: [1, 2, 3] },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });

    it("should deny assigning non-team members to team event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      const result = middleware({
        ctx: mockCtx,
        input: { id: 2, users: [1, 2, 999] },
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

      await expect(result).rejects.toThrow(TRPCError);
      await expect(result).rejects.toThrow("Cannot assign event to users outside of team membership");
    });

    it("should deny org admin from assigning org members who are not in the team", async () => {
      // Org admin (user 1) has permission but tries to assign org member (user 50) who's not in team
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      const result = middleware({
        ctx: mockCtx,
        input: { id: 2, users: [1, 50] }, // User 50 is an org member but not team member
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

      await expect(result).rejects.toThrow(TRPCError);
      await expect(result).rejects.toThrow("Cannot assign event to users outside of team membership");
    });

    it("should deny assigning only non-team members even if user has permission", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      const result = middleware({
        ctx: mockCtx,
        input: { id: 2, users: [100, 200, 300] }, // All users not in team
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

      await expect(result).rejects.toThrow(TRPCError);
      await expect(result).rejects.toThrow("Cannot assign event to users outside of team membership");
    });

    it("should allow empty users array", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 2, users: [] },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });

    it("should not validate users when not provided", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 2 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });
  });

  describe("with organizations enabled", () => {
    const teamEvent = {
      id: 2,
      userId: null,
      teamId: 10,
      users: [],
      team: {
        members: [{ userId: 2, accepted: true, role: MembershipRole.MEMBER }],
        parent: null,
      },
    };

    const runMiddleware = () =>
      getMiddleware(createEventPbacProcedure("eventType.update"))({
        ctx: mockCtx,
        input: { id: 2 },
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("should throw NOT_FOUND for a non-member of the team", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      await expect(runMiddleware()).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("should throw NOT_FOUND for a pending member of the team", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue({
        ...teamEvent,
        team: { members: [{ userId: 1, accepted: false, role: MembershipRole.ADMIN }], parent: null },
      });

      await expect(runMiddleware()).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("should allow an accepted admin of the team", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue({
        ...teamEvent,
        team: { members: [{ userId: 1, accepted: true, role: MembershipRole.ADMIN }], parent: null },
      });

      await expect(runMiddleware()).resolves.not.toThrow();
    });

    it("should throw FORBIDDEN for an accepted MEMBER of the team", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue({
        ...teamEvent,
        team: { members: [{ userId: 1, accepted: true, role: MembershipRole.MEMBER }], parent: null },
      });

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should allow an admin of the parent organization without team membership", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue({
        ...teamEvent,
        team: {
          members: [{ userId: 2, accepted: true, role: MembershipRole.MEMBER }],
          parent: { members: [{ userId: 1 }] },
        },
      });

      await expect(runMiddleware()).resolves.not.toThrow();
    });

    it("should still throw FORBIDDEN for a non-owner of a personal event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue({
        id: 1,
        userId: 2,
        teamId: null,
        users: [{ id: 2 }],
        team: null,
        owner: { organizationId: 100 },
      });

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("should throw NOT_FOUND for a personal event owned by another organization's user", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(otherOrgPersonalEvent);

      await expect(runMiddleware()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should allow the owner of a personal event regardless of the owner's organization", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue({ ...otherOrgPersonalEvent, userId: 1 });

      await expect(runMiddleware()).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should allow an assignee of a personal event owned by another organization's user", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue({ ...otherOrgPersonalEvent, users: [{ id: 1 }] });

      await expect(runMiddleware()).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("with organizations disabled", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("should throw FORBIDDEN for a personal event owned by another organization's user", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(otherOrgPersonalEvent);

      await expect(
        getMiddleware(createEventPbacProcedure("eventType.update"))({
          ctx: mockCtx,
          input: { id: 1 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("event not found", () => {
    it("should throw NOT_FOUND when event does not exist", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(null);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      const result = middleware({
        ctx: mockCtx,
        input: { id: 999 },
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

      await expect(result).rejects.toThrow(TRPCError);
      await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("input validation", () => {
    it("should accept eventTypeId as alternative to id", async () => {
      const event = {
        id: 1,
        userId: 1,
        teamId: null,
        users: [{ id: 1 }],
        team: null,
      };
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(event);

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { eventTypeId: 1 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();

      expect(mockPrisma.eventType.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        select: expect.any(Object),
      });
    });
  });

  describe("different permissions and fallback roles", () => {
    const teamEvent = {
      id: 2,
      userId: null,
      teamId: 10,
      users: [],
      team: {
        members: [{ userId: 1, accepted: true, role: MembershipRole.ADMIN }],
        parent: null,
      },
    };

    it("should allow access with custom permission string", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      const procedure = createEventPbacProcedure("eventType.delete");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 2 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });

    it("should throw FORBIDDEN for an ADMIN when custom fallback roles only allow OWNER", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(teamEvent);

      const procedure = createEventPbacProcedure("eventType.create", [MembershipRole.OWNER]);
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 2 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Permission required: eventType.create" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should allow an OWNER when custom fallback roles only allow OWNER", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue({
        ...teamEvent,
        team: { members: [{ userId: 1, accepted: true, role: MembershipRole.OWNER }], parent: null },
      });

      const procedure = createEventPbacProcedure("eventType.create", [MembershipRole.OWNER]);
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 2 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });
  });

  describe.each([
    { flag: "", refusalCode: "FORBIDDEN" },
    { flag: "1", refusalCode: "NOT_FOUND" },
  ])("role-based authorization (ORGANIZATIONS_ENABLED=$flag)", ({ flag, refusalCode }) => {
    const teamEventWith = (
      members: { userId: number; accepted: boolean; role: MembershipRole }[],
      parent: { members: { userId: number }[] } | null = null
    ) => ({ id: 2, userId: null, teamId: 10, users: [], team: { members, parent } });

    const runMiddleware = (procedure: ReturnType<typeof createEventPbacProcedure>) =>
      getMiddleware(procedure)({
        ctx: mockCtx,
        input: { id: 2 },
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", flag);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("should allow a MEMBER when MEMBER is among the allowed roles", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWith([{ userId: 1, accepted: true, role: MembershipRole.MEMBER }]));

      await expect(
        runMiddleware(
          createEventPbacProcedure("eventType.read", [
            MembershipRole.OWNER,
            MembershipRole.ADMIN,
            MembershipRole.MEMBER,
          ])
        )
      ).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should throw FORBIDDEN for a MEMBER with the default roles", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWith([{ userId: 1, accepted: true, role: MembershipRole.MEMBER }]));

      await expect(runMiddleware(createEventPbacProcedure("eventType.update"))).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Permission required: eventType.update",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should allow an ADMIN with the default roles", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWith([{ userId: 1, accepted: true, role: MembershipRole.ADMIN }]));

      await expect(runMiddleware(createEventPbacProcedure("eventType.update"))).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should allow an OWNER with the default roles", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWith([{ userId: 1, accepted: true, role: MembershipRole.OWNER }]));

      await expect(runMiddleware(createEventPbacProcedure("eventType.update"))).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });

    it(`should throw ${refusalCode} for a pending ADMIN`, async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWith([{ userId: 1, accepted: false, role: MembershipRole.ADMIN }]));

      await expect(runMiddleware(createEventPbacProcedure("eventType.update"))).rejects.toMatchObject({
        code: refusalCode,
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it(`should throw ${refusalCode} for a non-member of the team`, async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWith([{ userId: 2, accepted: true, role: MembershipRole.MEMBER }]));

      await expect(runMiddleware(createEventPbacProcedure("eventType.update"))).rejects.toMatchObject({
        code: refusalCode,
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it(`should throw ${refusalCode} for an admin of another team`, async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(
        teamEventWith([
          { userId: 2, accepted: true, role: MembershipRole.OWNER },
          { userId: 3, accepted: true, role: MembershipRole.ADMIN },
        ])
      );

      await expect(runMiddleware(createEventPbacProcedure("eventType.update"))).rejects.toMatchObject({
        code: refusalCode,
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it(`should ${flag ? "allow" : `throw ${refusalCode} for`} an admin of the parent organization who is not a team member`, async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(
        teamEventWith([{ userId: 2, accepted: true, role: MembershipRole.MEMBER }], {
          members: [{ userId: 1 }],
        })
      );

      if (flag) {
        await expect(runMiddleware(createEventPbacProcedure("eventType.update"))).resolves.not.toThrow();
        expect(mockNext).toHaveBeenCalled();
        return;
      }
      // After the switch-over every team sits under BlueBee; with organizations off its admins get nothing.
      await expect(runMiddleware(createEventPbacProcedure("eventType.update"))).rejects.toMatchObject({
        code: refusalCode,
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should throw FORBIDDEN when teamId is set but the team is missing", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue({ id: 2, userId: null, teamId: 10, users: [], team: null });

      await expect(runMiddleware(createEventPbacProcedure("eventType.update"))).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Permission required: eventType.update",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("ensureEmailOrPhoneNumberIsPresent", () => {
    it("should throw error when both email and phone are hidden", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: true,
          hidden: true,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: true,
          hidden: true,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(TRPCError);
      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(
        expect.objectContaining({
          code: "BAD_REQUEST",
          message: "booking_fields_email_and_phone_both_hidden",
        })
      );
    });

    it("should throw error when neither email nor phone is required", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: false,
          hidden: false,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: false,
          hidden: false,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(TRPCError);
      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(
        expect.objectContaining({
          code: "BAD_REQUEST",
          message: "booking_fields_email_or_phone_required",
        })
      );
    });

    it("should throw error when email is hidden and phone is not required", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: true,
          hidden: true,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: false,
          hidden: false,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(TRPCError);
      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(
        expect.objectContaining({
          code: "BAD_REQUEST",
          message: "booking_fields_phone_required_when_email_hidden",
        })
      );
    });

    it("should throw error when phone is hidden and email is not required", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: false,
          hidden: false,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: true,
          hidden: true,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(TRPCError);
      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(
        expect.objectContaining({
          code: "BAD_REQUEST",
          message: "booking_fields_email_required_when_phone_hidden",
        })
      );
    });

    it("should pass when email is visible and required while phone is hidden", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: true,
          hidden: false,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: false,
          hidden: true,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).not.toThrow();
    });

    it("should pass when phone is visible and required while email is hidden", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: false,
          hidden: true,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: true,
          hidden: false,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).not.toThrow();
    });

    it("should pass when both email and phone are visible and required", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: true,
          hidden: false,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: true,
          hidden: false,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).not.toThrow();
    });
  });
});

describe("eventOwnerProcedure", () => {
  const mockPrisma = {
    eventType: {
      findUnique: vi.fn(),
    },
  } as unknown as PrismaClient;

  const mockCtx = {
    user: { id: 1, organizationId: 100, profile: { upId: "user-1" } },
    session: { user: { id: 1 } },
    prisma: mockPrisma,
  };

  const mockNext = vi.fn().mockResolvedValue({ ctx: mockCtx });

  const middleware = eventOwnerProcedure._def.middlewares[eventOwnerProcedure._def.middlewares.length - 1];

  const runMiddleware = (users: number[] = []) =>
    middleware({
      ctx: mockCtx,
      input: { id: 2, users },
      next: mockNext,
      path: "test",
      type: "mutation",
      getRawInput: async () => ({}),
      meta: undefined,
    });

  const teamEventWithMembers = (
    members: { userId: number; role: MembershipRole; accepted: boolean }[],
    parent: { members: { userId: number }[] } | null = null
  ) => ({ userId: null, users: [], team: { members, parent } });

  const personalEventOwnedBy = (organizationId: number | null, userId = 2, users: { id: number }[] = []) => ({
    userId,
    users,
    team: null,
    owner: { organizationId },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should query the event with select and no include", async () => {
    mockPrisma.eventType.findUnique = vi
      .fn()
      .mockResolvedValue(teamEventWithMembers([{ userId: 1, role: MembershipRole.ADMIN, accepted: true }]));

    await runMiddleware();

    expect(mockPrisma.eventType.findUnique).toHaveBeenCalledWith({
      where: { id: 2 },
      select: expect.any(Object),
    });
    expect(vi.mocked(mockPrisma.eventType.findUnique).mock.calls[0][0]).not.toHaveProperty("include");
  });

  describe("with organizations disabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    });

    it("should throw FORBIDDEN for a non-member of the team", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWithMembers([{ userId: 2, role: MembershipRole.ADMIN, accepted: true }]));

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("should throw FORBIDDEN for an accepted member who is not an admin", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(
          teamEventWithMembers([{ userId: 1, role: MembershipRole.MEMBER, accepted: true }])
        );

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("should allow a team admin", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWithMembers([{ userId: 1, role: MembershipRole.ADMIN, accepted: true }]));

      await expect(runMiddleware()).resolves.not.toThrow();
    });

    it("should throw FORBIDDEN for a pending (invited, not accepted) admin", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(
          teamEventWithMembers([{ userId: 1, role: MembershipRole.ADMIN, accepted: false }])
        );

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should throw FORBIDDEN for a pending (invited, not accepted) owner", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(
          teamEventWithMembers([{ userId: 1, role: MembershipRole.OWNER, accepted: false }])
        );

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should allow an accepted team owner", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWithMembers([{ userId: 1, role: MembershipRole.OWNER, accepted: true }]));

      await expect(runMiddleware()).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should throw FORBIDDEN for an admin of the BlueBee parent organization", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(
        teamEventWithMembers([{ userId: 2, role: MembershipRole.ADMIN, accepted: true }], {
          members: [{ userId: 1 }],
        })
      );

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("should throw FORBIDDEN when assigning users outside the team", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWithMembers([{ userId: 1, role: MembershipRole.ADMIN, accepted: true }]));

      await expect(runMiddleware([1, 99])).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("should throw FORBIDDEN for a personal event owned by another organization's user", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(personalEventOwnedBy(200));

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("with organizations enabled", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("should throw NOT_FOUND for a non-member of the team", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWithMembers([{ userId: 2, role: MembershipRole.ADMIN, accepted: true }]));

      await expect(runMiddleware()).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("should throw FORBIDDEN for an accepted member who is not an admin", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(
          teamEventWithMembers([{ userId: 1, role: MembershipRole.MEMBER, accepted: true }])
        );

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("should allow a team admin", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(teamEventWithMembers([{ userId: 1, role: MembershipRole.ADMIN, accepted: true }]));

      await expect(runMiddleware()).resolves.not.toThrow();
    });

    it("should throw NOT_FOUND for a personal event owned by another organization's user", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(personalEventOwnedBy(200));

      await expect(runMiddleware()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should throw NOT_FOUND for a pending (invited, not accepted) admin", async () => {
      mockPrisma.eventType.findUnique = vi
        .fn()
        .mockResolvedValue(
          teamEventWithMembers([{ userId: 1, role: MembershipRole.ADMIN, accepted: false }])
        );

      await expect(runMiddleware()).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should allow an admin of the parent organization who is not a team member", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(
        teamEventWithMembers([{ userId: 2, role: MembershipRole.ADMIN, accepted: true }], {
          members: [{ userId: 1 }],
        })
      );

      await expect(runMiddleware()).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should throw FORBIDDEN for a same-organization non-owner of a personal event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(personalEventOwnedBy(100));

      await expect(runMiddleware()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("should allow the owner of a personal event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(personalEventOwnedBy(200, 1));

      await expect(runMiddleware()).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should allow an assignee of a personal event", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(personalEventOwnedBy(200, 2, [{ id: 1 }]));

      await expect(runMiddleware()).resolves.not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });

    it("should throw FORBIDDEN, not NOT_FOUND, when the owner assigns users other than themselves", async () => {
      mockPrisma.eventType.findUnique = vi.fn().mockResolvedValue(personalEventOwnedBy(200, 1));

      await expect(runMiddleware([99])).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });
});
