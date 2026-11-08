import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { PrismaClient } from "@calcom/prisma";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { getHandler } from "./get.handler";

const { mockGetEventTypeById } = vi.hoisted(() => ({ mockGetEventTypeById: vi.fn() }));

vi.mock("@calcom/features/eventtypes/lib/getEventTypeById", () => ({
  default: mockGetEventTypeById,
}));

describe("getHandler", () => {
  const ctx = {
    user: {
      id: 5,
      locale: "en",
      profile: { organizationId: 1 },
      organization: { isOrgAdmin: false },
    },
    prisma: {},
  } as unknown as Parameters<typeof getHandler>[0]["ctx"] & { prisma: PrismaClient };

  it("returns the event type assembly", async () => {
    mockGetEventTypeById.mockResolvedValue({ eventType: { id: 10 } });

    await expect(getHandler({ ctx, input: { id: 10 } })).resolves.toEqual({ eventType: { id: 10 } });
    expect(mockGetEventTypeById).toHaveBeenCalledWith({
      currentOrganizationId: 1,
      eventTypeId: 10,
      userId: 5,
      prisma: ctx.prisma,
      isUserOrganizationAdmin: false,
      userLocale: "en",
    });
  });

  it("treats a user without profile or organization as a non-org-admin", async () => {
    mockGetEventTypeById.mockResolvedValue({ eventType: { id: 10 } });
    const bareCtx = { user: { id: 5, locale: "en" }, prisma: {} } as unknown as Parameters<
      typeof getHandler
    >[0]["ctx"];

    await expect(getHandler({ ctx: bareCtx, input: { id: 10 } })).resolves.toEqual({
      eventType: { id: 10 },
    });
    expect(mockGetEventTypeById).toHaveBeenCalledWith(
      expect.objectContaining({
        currentOrganizationId: null,
        isUserOrganizationAdmin: false,
      })
    );
  });

  it("converts an ErrorWithCode into a TRPCError at the router edge", async () => {
    mockGetEventTypeById.mockRejectedValue(new ErrorWithCode(ErrorCode.NotFound, "Event type 10 not found"));

    const error = await getHandler({ ctx, input: { id: 10 } }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("NOT_FOUND");
  });

  it("rethrows non-domain errors unchanged", async () => {
    const cause = new Error("boom");
    mockGetEventTypeById.mockRejectedValue(cause);

    await expect(getHandler({ ctx, input: { id: 10 } })).rejects.toBe(cause);
  });
});
