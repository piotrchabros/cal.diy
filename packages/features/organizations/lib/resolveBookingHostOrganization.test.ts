import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertEventTypeInHostOrganization,
  getEventTypeOrganizationId,
  resolveBookingHostOrganization,
} from "./resolveBookingHostOrganization";

const { mockResolve } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
}));

vi.mock("../di/OrganizationDomainResolver.container", () => ({
  getOrganizationDomainResolver: () => ({ resolve: mockResolve }),
}));

const bespokesoft = { id: 7, slug: "bespokesoft", domain: "cal.bespokesoft.pl", isDefault: false };
const defaultOrg = { id: 1, slug: "default", domain: "cal.example.com", isDefault: true };

describe("resolveBookingHostOrganization", () => {
  beforeEach(() => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mockResolve.mockResolvedValue(bespokesoft);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("returns nulls without resolving when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");

    await expect(
      resolveBookingHostOrganization({
        hostname: "cal.bespokesoft.pl",
        forcedSlug: "acme",
        isPlatform: false,
      })
    ).resolves.toEqual({ orgSlug: null, hostOrganization: null });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("keeps only the forced slug for platform requests", async () => {
    await expect(
      resolveBookingHostOrganization({ hostname: "cal.bespokesoft.pl", forcedSlug: "acme", isPlatform: true })
    ).resolves.toEqual({ orgSlug: "acme", hostOrganization: null });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("uses the host organization even when a forced slug is given", async () => {
    await expect(
      resolveBookingHostOrganization({
        hostname: "cal.bespokesoft.pl",
        forcedSlug: "acme",
        isPlatform: false,
      })
    ).resolves.toEqual({ orgSlug: "bespokesoft", hostOrganization: bespokesoft });
    expect(mockResolve).toHaveBeenCalledWith("cal.bespokesoft.pl");
  });

  it("falls back to the forced slug when the host is unknown", async () => {
    mockResolve.mockResolvedValue(null);

    await expect(
      resolveBookingHostOrganization({ hostname: "api.example.com", forcedSlug: "acme", isPlatform: false })
    ).resolves.toEqual({ orgSlug: "acme", hostOrganization: null });
  });

  it("returns a null slug when the host is unknown and no slug is forced", async () => {
    mockResolve.mockResolvedValue(null);

    await expect(
      resolveBookingHostOrganization({
        hostname: "api.example.com",
        forcedSlug: undefined,
        isPlatform: false,
      })
    ).resolves.toEqual({ orgSlug: null, hostOrganization: null });
  });

  it("does not resolve an empty hostname", async () => {
    await expect(
      resolveBookingHostOrganization({ hostname: "", forcedSlug: "acme", isPlatform: false })
    ).resolves.toEqual({ orgSlug: "acme", hostOrganization: null });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("rejects when the resolver throws", async () => {
    mockResolve.mockRejectedValue(new Error("db down"));

    await expect(
      resolveBookingHostOrganization({ hostname: "cal.bespokesoft.pl", forcedSlug: null, isPlatform: false })
    ).rejects.toThrow("db down");
  });
});

describe("getEventTypeOrganizationId", () => {
  it("returns the parent organization of the event type's team", () => {
    expect(getEventTypeOrganizationId({ team: { id: 20, parentId: 7 } })).toBe(7);
  });

  it("returns the team id when the team is itself an organization", () => {
    expect(getEventTypeOrganizationId({ team: { id: 7, parentId: null, isOrganization: true } })).toBe(7);
  });

  it("returns the organization of the parent's team for managed children", () => {
    expect(getEventTypeOrganizationId({ team: null, parent: { team: { parentId: 7 } } })).toBe(7);
  });

  it("returns the owner's organization", () => {
    expect(getEventTypeOrganizationId({ owner: { organizationId: 7 } })).toBe(7);
  });

  it("returns null when the event type has no organization", () => {
    expect(
      getEventTypeOrganizationId({ team: { id: 20, parentId: null }, owner: { organizationId: null } })
    ).toBeNull();
  });
});

describe("assertEventTypeInHostOrganization", () => {
  it("does nothing without a host organization", () => {
    expect(() =>
      assertEventTypeInHostOrganization({
        hostOrganization: null,
        eventTypeOrganizationId: 9,
        eventTypeId: 5,
      })
    ).not.toThrow();
  });

  it("does nothing for dynamic events with id 0", () => {
    expect(() =>
      assertEventTypeInHostOrganization({
        hostOrganization: bespokesoft,
        eventTypeOrganizationId: 9,
        eventTypeId: 0,
      })
    ).not.toThrow();
  });

  it("passes when the event type belongs to the host organization", () => {
    expect(() =>
      assertEventTypeInHostOrganization({
        hostOrganization: bespokesoft,
        eventTypeOrganizationId: 7,
        eventTypeId: 5,
      })
    ).not.toThrow();
  });

  it("passes for an event type without organization on the default host", () => {
    expect(() =>
      assertEventTypeInHostOrganization({
        hostOrganization: defaultOrg,
        eventTypeOrganizationId: null,
        eventTypeId: 5,
      })
    ).not.toThrow();
  });

  it("throws for an event type without organization on a non-default host", () => {
    expect(() =>
      assertEventTypeInHostOrganization({
        hostOrganization: bespokesoft,
        eventTypeOrganizationId: null,
        eventTypeId: 5,
      })
    ).toThrow("event_not_found");
  });

  it("throws a NotFound ErrorWithCode for an event type in another organization", () => {
    let thrown: unknown;
    try {
      assertEventTypeInHostOrganization({
        hostOrganization: bespokesoft,
        eventTypeOrganizationId: 9,
        eventTypeId: 5,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ErrorWithCode);
    expect((thrown as ErrorWithCode).code).toBe(ErrorCode.NotFound);
    expect((thrown as ErrorWithCode).message).toBe("event_not_found");
  });
});
