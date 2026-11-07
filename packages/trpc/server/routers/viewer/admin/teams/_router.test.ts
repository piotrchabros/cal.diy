import prisma, { readonlyPrisma } from "@calcom/prisma";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TRPCContextInner } from "../../../../createContext";
import { createCallerFactory } from "../../../../trpc";
import { teamsRouter } from "./_router";

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  findManyPaginated: vi.fn(),
}));

vi.mock("@calcom/features/auth/lib/userFromSessionUtils", () => ({
  getUserSession: mocks.getUserSession,
}));

vi.mock("@calcom/prisma", () => {
  const fake = {};
  return { default: fake, prisma: fake, readonlyPrisma: fake, availabilityUserSelect: {}, userSelect: {} };
});

vi.mock("@sentry/nextjs", () => ({ setUser: vi.fn() }));

vi.mock("@calcom/features/teams/di/TeamRepository.container", () => ({
  getTeamRepository: () => ({ findManyPaginated: mocks.findManyPaginated }),
}));

const ctx: TRPCContextInner = {
  prisma,
  insightsDb: readonlyPrisma,
  locale: "en",
  traceContext: { traceId: "trace_test", spanId: "span_test", operation: "test" },
};

const createCaller = createCallerFactory(teamsRouter);

const team = {
  id: 11,
  name: "Sales",
  slug: "sales",
  memberCount: 4,
  organization: { id: 5, name: "Acme" },
};

const sessionFor = (role: "ADMIN" | "USER") => ({
  user: { id: 7, role },
  session: { upId: "usr-7", expires: "2099-01-01T00:00:00.000Z", user: { id: 7 } },
});

describe("admin teams router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mocks.getUserSession.mockResolvedValue(sessionFor("ADMIN"));
    mocks.findManyPaginated.mockResolvedValue({ items: [team], nextCursor: 11, total: 42 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("access control", () => {
    it("returns NOT_FOUND to an admin while the feature flag is off", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");

      await expect(createCaller(ctx).listPaginated({ limit: 10 })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(mocks.findManyPaginated).not.toHaveBeenCalled();
    });

    it("rejects a non-admin without calling the repository", async () => {
      mocks.getUserSession.mockResolvedValue(sessionFor("USER"));

      await expect(createCaller(ctx).listPaginated({ limit: 10 })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(mocks.findManyPaginated).not.toHaveBeenCalled();
    });

    it("rejects a request without a session", async () => {
      mocks.getUserSession.mockResolvedValue({ user: null, session: null });

      await expect(createCaller(ctx).listPaginated({ limit: 10 })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(mocks.findManyPaginated).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    it.each([0, 101])("rejects limit %s", async (limit) => {
      await expect(createCaller(ctx).listPaginated({ limit })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.findManyPaginated).not.toHaveBeenCalled();
    });

    it.each([0, -1])("rejects organizationId %s", async (organizationId) => {
      await expect(createCaller(ctx).listPaginated({ limit: 10, organizationId })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(mocks.findManyPaginated).not.toHaveBeenCalled();
    });
  });

  describe("listPaginated", () => {
    it("maps repository items, cursor and total to rows, nextCursor and meta", async () => {
      await expect(createCaller(ctx).listPaginated({ limit: 10 })).resolves.toEqual({
        rows: [team],
        nextCursor: 11,
        meta: { totalRowCount: 42 },
      });
    });

    it("passes search, organization filter, cursor and limit through", async () => {
      await createCaller(ctx).listPaginated({ limit: 20, cursor: 3, searchTerm: " sal ", organizationId: 5 });

      expect(mocks.findManyPaginated).toHaveBeenCalledWith({
        search: "sal",
        parentId: 5,
        cursor: 3,
        limit: 20,
      });
    });

    it("strips fields that are not part of the DTO", async () => {
      mocks.findManyPaginated.mockResolvedValue({
        items: [{ ...team, internalNote: "secret" }],
        nextCursor: undefined,
        total: 1,
      });

      const result = await createCaller(ctx).listPaginated({ limit: 10 });

      expect(result).toEqual({ rows: [team], meta: { totalRowCount: 1 } });
      expect(result.rows[0]).not.toHaveProperty("internalNote");
    });
  });
});
