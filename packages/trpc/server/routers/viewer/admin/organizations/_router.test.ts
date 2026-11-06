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
  delete: vi.fn(),
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
    delete: mocks.delete,
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
  user: { id: 7, role },
  session: { upId: "usr-7", expires: "2099-01-01T00:00:00.000Z", user: { id: 7 } },
});

const serviceMocks = () => [mocks.list, mocks.get, mocks.create, mocks.update, mocks.delete];

const callEveryProcedure = (caller: ReturnType<typeof createCaller>) => [
  caller.list({}),
  caller.get({ id: 5 }),
  caller.create(validCreateInput),
  caller.update({ id: 5, name: "Acme 2" }),
  caller.delete({ id: 5 }),
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
    mocks.delete.mockResolvedValue({ id: 5 });
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

    it.each([
      ["an empty owner", { ...validCreateInput, owner: {} }],
      ["an owner with extra keys", { ...validCreateInput, owner: { userId: 1, email: "x" } }],
      ["a missing domain", { name: "Acme", slug: "acme", owner: { userId: 9 } }],
      ["a name over 100 characters", { ...validCreateInput, name: "a".repeat(101) }],
    ])("rejects create with %s", async (_label, input) => {
      await expect(
        createCaller(ctx).create(input as Parameters<ReturnType<typeof createCaller>["create"]>[0])
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.create).not.toHaveBeenCalled();
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

    it("creates with the input and the acting admin id", async () => {
      const input = { ...validCreateInput, confirmMoveOwner: true };

      await createCaller(ctx).create(input);

      expect(mocks.create).toHaveBeenCalledWith(input, 7);
    });

    it("updates with the id, the remaining fields and the acting admin id", async () => {
      await createCaller(ctx).update({ id: 5, name: "Acme 2", domain: "acme2.example.com" });

      expect(mocks.update).toHaveBeenCalledWith(5, { name: "Acme 2", domain: "acme2.example.com" }, 7);
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
      ["NotFound", "NOT_FOUND", "Organization not found"],
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
