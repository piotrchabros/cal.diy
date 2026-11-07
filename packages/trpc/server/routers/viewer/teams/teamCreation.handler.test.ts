import { ErrorWithCode } from "@calcom/lib/errors";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "./create.handler";
import { isSlugAvailableHandler } from "./isSlugAvailable.handler";

const mocks = vi.hoisted(() => ({
  createTeam: vi.fn(),
  isSlugAvailable: vi.fn(),
}));

vi.mock("@calcom/features/teams/services/TeamCreationService", () => ({
  TeamCreationService: {
    normalizeSlug: (slug: string) => slug.toLowerCase(),
  },
}));

vi.mock("@calcom/features/teams/di/TeamCreationService.container", () => ({
  getTeamCreationService: () => ({
    createTeam: mocks.createTeam,
    isSlugAvailable: mocks.isSlugAvailable,
  }),
}));

const createInput = { name: "Sales", slug: "sales" };

const ctxFor = (organizationId: number | null) => ({ user: { id: 7, organizationId } });

describe("team creation handlers", () => {
  beforeEach(() => {
    mocks.createTeam.mockResolvedValue({ id: 1, slug: "sales" });
    mocks.isSlugAvailable.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe.each([
    { flag: "", organizationId: 5, expected: null },
    { flag: "1", organizationId: 5, expected: 5 },
    { flag: "1", organizationId: null, expected: null },
  ])("with ORGANIZATIONS_ENABLED=$flag and user organizationId $organizationId", ({
    flag,
    organizationId,
    expected,
  }) => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", flag);
    });

    it(`create passes organizationId ${expected} to the service`, async () => {
      await createHandler({ ctx: ctxFor(organizationId), input: createInput });

      expect(mocks.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 7, slug: "sales", organizationId: expected })
      );
    });

    it(`isSlugAvailable passes organizationId ${expected} to the service`, async () => {
      const result = await isSlugAvailableHandler({ ctx: ctxFor(organizationId), input: { slug: "Sales" } });

      expect(mocks.isSlugAvailable).toHaveBeenCalledWith("Sales", expected);
      expect(result).toEqual({ available: true, slug: "sales" });
    });
  });

  it("create converts an ErrorWithCode BadRequest into a TRPCError BAD_REQUEST", async () => {
    mocks.createTeam.mockRejectedValue(ErrorWithCode.Factory.BadRequest("Slug is taken"));

    const promise = createHandler({ ctx: ctxFor(null), input: createInput });

    await expect(promise).rejects.toBeInstanceOf(TRPCError);
    await expect(promise).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Slug is taken" });
  });
});
