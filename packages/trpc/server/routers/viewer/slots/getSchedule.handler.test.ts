import type { IncomingHttpHeaders } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getScheduleHandler } from "./getSchedule.handler";
import type { ContextForGetSchedule, TGetScheduleInputSchema } from "./types";

const { getAvailableSlots, resolve, findByIdIncludeTeamAndOwnerOrganization } = vi.hoisted(() => ({
  getAvailableSlots: vi.fn(),
  resolve: vi.fn(),
  findByIdIncludeTeamAndOwnerOrganization: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({ prisma: {} }));

vi.mock("@calcom/features/eventtypes/repositories/eventTypeRepository", () => ({
  EventTypeRepository: class {
    findByIdIncludeTeamAndOwnerOrganization = findByIdIncludeTeamAndOwnerOrganization;
  },
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
    findByIdIncludeTeamAndOwnerOrganization.mockReset();
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

  describe("with a direct eventTypeId", () => {
    const idInput = {
      startTime: baseInput.startTime,
      endTime: baseInput.endTime,
      eventTypeId: 42,
      orgSlug: null,
    } as TGetScheduleInputSchema;
    const acmeCtx = () =>
      buildCtx({ host: "acme.example.com", "x-cal-org-id": "7", "x-cal-org-slug": "acme" });

    function eventTypeOwnedBy(organizationId: number | null) {
      return { id: 42, team: null, parent: null, owner: { organizationId } };
    }

    it("does not look up the event type when organizations are disabled", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "0");

      await getScheduleHandler({ ctx: acmeCtx(), input: idInput });

      expect(findByIdIncludeTeamAndOwnerOrganization).not.toHaveBeenCalled();
      expect(passedInput()).toBe(idInput);
    });

    it("serves an event type of the request organization", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      findByIdIncludeTeamAndOwnerOrganization.mockResolvedValue(eventTypeOwnedBy(7));

      await getScheduleHandler({ ctx: acmeCtx(), input: idInput });

      expect(findByIdIncludeTeamAndOwnerOrganization).toHaveBeenCalledWith({ id: 42 });
      expect(passedInput()).toEqual({ ...idInput, orgSlug: "acme" });
    });

    it("serves a team event type whose team belongs to the request organization", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      findByIdIncludeTeamAndOwnerOrganization.mockResolvedValue({
        id: 42,
        team: { id: 9, parentId: 7, isOrganization: false },
        parent: null,
        owner: null,
      });

      await getScheduleHandler({ ctx: acmeCtx(), input: idInput });

      expect(getAvailableSlots).toHaveBeenCalled();
    });

    it("refuses an event type of another organization with NOT_FOUND", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      findByIdIncludeTeamAndOwnerOrganization.mockResolvedValue(eventTypeOwnedBy(8));

      await expect(getScheduleHandler({ ctx: acmeCtx(), input: idInput })).rejects.toMatchObject({
        code: "not_found_error",
      });
      expect(getAvailableSlots).not.toHaveBeenCalled();
    });

    it("refuses an event type outside any organization on a non-default organization's domain", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      findByIdIncludeTeamAndOwnerOrganization.mockResolvedValue(eventTypeOwnedBy(null));

      await expect(getScheduleHandler({ ctx: acmeCtx(), input: idInput })).rejects.toThrow("event_not_found");
    });

    it("serves an event type outside any organization on the default organization's domain", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      resolve.mockResolvedValue({ id: 1, slug: "bluebee", domain: "cal.example.com", isDefault: true });
      findByIdIncludeTeamAndOwnerOrganization.mockResolvedValue(eventTypeOwnedBy(null));

      await getScheduleHandler({ ctx: buildCtx({ host: "cal.example.com" }), input: idInput });

      expect(passedInput()).toEqual({ ...idInput, orgSlug: "bluebee" });
    });

    it("refuses when the request host resolves to no organization", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      resolve.mockResolvedValue(null);

      await expect(
        getScheduleHandler({ ctx: buildCtx({ host: "unknown.example.com" }), input: idInput })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(findByIdIncludeTeamAndOwnerOrganization).not.toHaveBeenCalled();
    });

    it("leaves a missing event type to the slots service", async () => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      findByIdIncludeTeamAndOwnerOrganization.mockResolvedValue(null);

      await getScheduleHandler({ ctx: acmeCtx(), input: idInput });

      expect(getAvailableSlots).toHaveBeenCalled();
    });
  });
});
