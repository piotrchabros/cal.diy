import type { IncomingHttpHeaders } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getScheduleHandler } from "./getSchedule.handler";
import type { ContextForGetSchedule, TGetScheduleInputSchema } from "./types";

const { getAvailableSlots, resolve } = vi.hoisted(() => ({
  getAvailableSlots: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@calcom/features/di/containers/AvailableSlots", () => ({
  getAvailableSlotsService: () => ({ getAvailableSlots }),
}));

vi.mock("@calcom/features/organizations/di/OrganizationDomainResolver.container", () => ({
  getOrganizationDomainResolver: () => ({ resolve }),
}));

const baseInput = {
  startTime: "2026-11-06T00:00:00.000Z",
  endTime: "2026-11-07T00:00:00.000Z",
  eventTypeSlug: "intro",
  usernameList: ["alice"],
  orgSlug: "evil",
} as TGetScheduleInputSchema;

function buildCtx(headers: IncomingHttpHeaders): ContextForGetSchedule {
  return { req: { headers, cookies: {} } as unknown as ContextForGetSchedule["req"] };
}

function passedInput(): TGetScheduleInputSchema {
  return getAvailableSlots.mock.calls[0][0].input;
}

describe("getScheduleHandler", () => {
  beforeEach(() => {
    getAvailableSlots.mockReset().mockResolvedValue({ slots: {} });
    resolve.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the input through untouched when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "0");
    const ctx = buildCtx({ "x-cal-org-id": "7", "x-cal-org-slug": "acme" });

    await getScheduleHandler({ ctx, input: baseInput });

    expect(passedInput()).toBe(baseInput);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("passes the input through untouched when there is no request", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await getScheduleHandler({ ctx: {}, input: baseInput });

    expect(passedInput()).toBe(baseInput);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("overrides the client orgSlug with the proxy-resolved organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    const ctx = buildCtx({ host: "acme.example.com", "x-cal-org-id": "7", "x-cal-org-slug": "acme" });

    await getScheduleHandler({ ctx, input: baseInput });

    expect(passedInput()).toEqual({ ...baseInput, orgSlug: "acme" });
    expect(getAvailableSlots.mock.calls[0][0].ctx).toBe(ctx);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("clears the orgSlug when the request resolves to no organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    resolve.mockResolvedValue(null);
    const ctx = buildCtx({ host: "unknown.example.com" });

    await getScheduleHandler({ ctx, input: baseInput });

    expect(resolve).toHaveBeenCalledWith("unknown.example.com");
    expect(passedInput().orgSlug).toBeNull();
  });

  it("uses the resolver's organization slug when the proxy headers are absent", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    resolve.mockResolvedValue({ id: 3, slug: "beta", domain: null, isDefault: false });
    const ctx = buildCtx({ host: "beta.example.com" });

    await getScheduleHandler({ ctx, input: baseInput });

    expect(passedInput().orgSlug).toBe("beta");
  });

  it("handles array-valued headers", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    resolve.mockResolvedValue(null);
    const ctx = buildCtx({ "x-cal-org-id": ["7"], "x-cal-org-slug": ["acme"] } as IncomingHttpHeaders);

    await getScheduleHandler({ ctx, input: baseInput });

    expect(passedInput().orgSlug).toBe("acme");
  });
});
