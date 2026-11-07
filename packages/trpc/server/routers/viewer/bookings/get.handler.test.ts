import getAllUserBookings from "@calcom/features/bookings/lib/getAllUserBookings";
import type { DB } from "@calcom/kysely";
import type { PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/enums";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBookings, getHandler } from "./get.handler";

vi.mock("@calcom/features/bookings/lib/getAllUserBookings");
vi.mock("@calcom/kysely", () => ({
  default: {
    selectFrom: vi.fn(),
    executeQuery: vi.fn(),
  },
}));
vi.mock("@calcom/lib/logger", () => ({
  default: {
    getSubLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe("getHandler", () => {
  const mockUser = {
    id: 1,
    email: "user@example.com",
    name: "Test User",
    profile: {
      organizationId: null,
    },
  };

  const mockPrisma = {} as unknown as PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return bookings successfully", async () => {
    const mockBookings = [
      {
        id: 1,
        uid: "booking-1",
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        rescheduler: null,
        eventType: {
          recurringEvent: null,
          eventTypeColor: null,
          price: 0,
          currency: "usd",
          metadata: {},
        },
      },
    ] as any;

    vi.mocked(getAllUserBookings).mockResolvedValue({
      bookings: mockBookings,
      recurringInfo: [],
      totalCount: 1,
    });

    const result = await getHandler({
      ctx: {
        user: mockUser as any,
        prisma: mockPrisma,
      },
      input: {
        filters: {},
        limit: 10,
        offset: 0,
      },
    });

    expect(result.bookings).toEqual(mockBookings);
    expect(result.totalCount).toBe(1);
    expect(getAllUserBookings).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          user: expect.objectContaining({
            id: mockUser.id,
            email: mockUser.email,
            orgId: null,
          }),
        }),
        filters: {},
        take: 10,
        skip: 0,
        bookingListingByStatus: ["upcoming"],
      })
    );
  });
});

describe("getBookings - team role checks", () => {
  const mockUser = {
    id: 1,
    email: "user@example.com",
    orgId: null,
  };

  const mockPrisma = {
    membership: {
      findMany: vi.fn(),
    },
    team: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findMany: vi.fn(),
    },
    eventType: {
      findMany: vi.fn(),
    },
    booking: {
      findUnique: vi.fn(),
      groupBy: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  } as unknown as PrismaClient;

  const createMockKysely = () => {
    const mockQueryBuilder = {
      select: vi.fn((arg?: unknown) => {
        if (typeof arg === "function") {
          return mockQueryBuilder;
        }
        return mockQueryBuilder;
      }),
      selectAll: vi.fn(() => mockQueryBuilder),
      where: vi.fn(() => mockQueryBuilder),
      innerJoin: vi.fn(() => mockQueryBuilder),
      union: vi.fn(() => mockQueryBuilder),
      unionAll: vi.fn(() => mockQueryBuilder),
      distinct: vi.fn(() => mockQueryBuilder),
      as: vi.fn(() => mockQueryBuilder),
      $if: vi.fn(() => mockQueryBuilder),
      orderBy: vi.fn(() => mockQueryBuilder),
      limit: vi.fn(() => mockQueryBuilder),
      offset: vi.fn(() => mockQueryBuilder),
      compile: vi.fn(() => ({ sql: "SELECT * FROM bookings" })),
      executeTakeFirst: vi.fn().mockResolvedValue({ bookingCount: 0 }),
      execute: vi.fn().mockResolvedValue([]),
    };

    return {
      selectFrom: vi.fn(() => mockQueryBuilder),
      executeQuery: vi.fn().mockResolvedValue({ rows: [] }),
      _mockQueryBuilder: mockQueryBuilder,
    } as unknown as Kysely<DB> & { _mockQueryBuilder: typeof mockQueryBuilder };
  };

  let mockKysely: ReturnType<typeof createMockKysely>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.team.findMany = vi.fn().mockResolvedValue([]);
    mockKysely = createMockKysely();
  });

  const listBookings = (filters: Parameters<typeof getBookings>[0]["filters"] = {}) =>
    getBookings({
      user: mockUser,
      prisma: mockPrisma,
      kysely: mockKysely as unknown as Kysely<DB>,
      bookingListingByStatus: ["upcoming"],
      filters,
      take: 10,
      skip: 0,
    });

  it("looks up teams where the user is an accepted admin/owner instead of a stub", async () => {
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await listBookings();

    expect(mockPrisma.team.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          {
            members: {
              some: {
                userId: mockUser.id,
                accepted: true,
                role: { in: [MembershipRole.ADMIN, MembershipRole.OWNER] },
              },
            },
          },
        ]),
      }),
      select: { id: true },
    });
  });

  it("adds team booking queries limited to accepted members for an accepted team admin", async () => {
    mockPrisma.team.findMany = vi.fn().mockResolvedValue([{ id: 10 }]);
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await listBookings();

    const subqueryWhere = vi.fn();
    const subqueryBuilder: Record<string, unknown> = {};
    for (const method of ["selectFrom", "select", "innerJoin"])
      subqueryBuilder[method] = () => subqueryBuilder;
    subqueryBuilder.where = (...args: unknown[]) => {
      subqueryWhere(...args);
      return subqueryBuilder;
    };
    const subqueries = mockKysely._mockQueryBuilder.where.mock.calls
      .map((call) => call[2])
      .filter((arg): arg is (eb: unknown) => unknown => typeof arg === "function");
    for (const subquery of subqueries) subquery(subqueryBuilder);

    expect(subqueries).toHaveLength(4);
    expect(subqueryWhere).toHaveBeenCalledWith("EventType.teamId", "in", [10]);
    expect(subqueryWhere).toHaveBeenCalledWith("Membership.teamId", "in", [10]);
    expect(subqueryWhere.mock.calls.filter((call) => call[0] === "Membership.accepted")).toEqual([
      ["Membership.accepted", "=", true],
      ["Membership.accepted", "=", true],
      ["Membership.accepted", "=", true],
    ]);
  });

  it("adds no team booking queries for a user without an accepted admin/owner role", async () => {
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await listBookings();

    const subqueries = mockKysely._mockQueryBuilder.where.mock.calls.filter(
      (call) => typeof call[2] === "function"
    );
    expect(subqueries).toHaveLength(0);
  });

  it("lets a team admin filter by an accepted member of their team", async () => {
    mockPrisma.team.findMany = vi.fn().mockResolvedValue([{ id: 10 }]);
    mockPrisma.user.findMany = vi.fn().mockResolvedValue([{ id: 4, email: "member@example.com" }]);
    mockPrisma.eventType.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await expect(listBookings({ userIds: [4] })).resolves.not.toThrow();
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: { teams: { some: { teamId: { in: [10] }, accepted: true } } },
      select: { id: true },
    });
  });

  it("refuses filtering by another user's id without an accepted admin/owner role", async () => {
    mockPrisma.user.findMany = vi.fn().mockResolvedValue([{ id: 4, email: "member@example.com" }]);
    mockPrisma.eventType.findMany = vi.fn().mockResolvedValue([]);

    await expect(listBookings({ userIds: [4] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("should allow access when filtering by own userId", async () => {
    mockPrisma.user.findMany = vi.fn((args: { where?: { id?: { in?: number[] } } }) => {
      if (args?.where?.id?.in?.includes(1)) {
        return Promise.resolve([{ id: 1, email: "user@example.com" }]) as ReturnType<
          typeof mockPrisma.user.findMany
        >;
      }
      return Promise.resolve([]) as ReturnType<typeof mockPrisma.user.findMany>;
    });
    mockPrisma.eventType.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await expect(
      getBookings({
        user: mockUser,
        prisma: mockPrisma,
        kysely: mockKysely as unknown as Kysely<DB>,
        bookingListingByStatus: ["upcoming"],
        filters: {
          userIds: [1],
        },
        take: 10,
        skip: 0,
      })
    ).resolves.not.toThrow();
  });

  it("should throw BAD_REQUEST when filtering by non-existent userIds", async () => {
    mockPrisma.user.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.eventType.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await expect(
      getBookings({
        user: mockUser,
        prisma: mockPrisma,
        kysely: mockKysely as unknown as Kysely<DB>,
        bookingListingByStatus: ["upcoming"],
        filters: {
          userIds: [4],
        },
        take: 10,
        skip: 0,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The requested users do not exist.",
    });
  });

  it("should execute query via kysely when no userIds filter is provided", async () => {
    mockPrisma.user.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.eventType.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await getBookings({
      user: mockUser,
      prisma: mockPrisma,
      kysely: mockKysely as unknown as Kysely<DB>,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 10,
      skip: 0,
    });

    expect(
      (mockKysely as unknown as { executeQuery: ReturnType<typeof vi.fn> }).executeQuery
    ).toHaveBeenCalled();
  });

  it("should NOT fetch user IDs when no userIds filter is provided", async () => {
    mockPrisma.user.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.eventType.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await getBookings({
      user: mockUser,
      prisma: mockPrisma,
      kysely: mockKysely as unknown as Kysely<DB>,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 10,
      skip: 0,
    });

    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("should use unionAll for combining booking queries", async () => {
    mockPrisma.user.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await getBookings({
      user: mockUser,
      prisma: mockPrisma,
      kysely: mockKysely as unknown as Kysely<DB>,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 10,
      skip: 0,
    });

    expect(mockKysely._mockQueryBuilder.unionAll).toHaveBeenCalled();
  });

  it("should apply DISTINCT on the outer select", async () => {
    mockPrisma.user.findMany = vi.fn().mockResolvedValue([]);
    mockPrisma.booking.groupBy = vi.fn().mockResolvedValue([]);

    await getBookings({
      user: mockUser,
      prisma: mockPrisma,
      kysely: mockKysely as unknown as Kysely<DB>,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 10,
      skip: 0,
    });

    expect(mockKysely._mockQueryBuilder.distinct).toHaveBeenCalled();
  });
});
