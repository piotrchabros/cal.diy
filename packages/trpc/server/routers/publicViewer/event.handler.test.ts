import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventHandler } from "./event.handler";
import type { TEventInputSchema } from "./event.schema";

const { getPublicEvent, resolve } = vi.hoisted(() => ({
  getPublicEvent: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@calcom/features/eventtypes/repositories/EventRepository", () => ({
  EventRepository: { getPublicEvent },
}));

vi.mock("@calcom/features/organizations/di/OrganizationDomainResolver.container", () => ({
  getOrganizationDomainResolver: () => ({ resolve }),
}));

const input: TEventInputSchema = {
  username: "alice",
  eventSlug: "intro",
  org: "evil",
  fromRedirectOfNonOrgLink: false,
};

describe("publicViewer eventHandler", () => {
  beforeEach(() => {
    getPublicEvent.mockReset().mockResolvedValue({ id: 1 });
    resolve.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the client org through when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "0");

    const result = await eventHandler({ input, userId: 5, headers: { host: "acme.example.com" } });

    expect(result).toEqual({ id: 1 });
    expect(getPublicEvent).toHaveBeenCalledWith(input, 5);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("passes the client org through when there is no request", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await eventHandler({ input });

    expect(getPublicEvent).toHaveBeenCalledWith(input, undefined);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("replaces the client org with the proxy-resolved host organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");

    await eventHandler({
      input,
      userId: 5,
      headers: { host: "acme.example.com", "x-cal-org-id": "7", "x-cal-org-slug": "acme" },
    });

    expect(getPublicEvent).toHaveBeenCalledWith({ ...input, org: "acme" }, 5);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("uses the resolver's organization when the proxy headers are absent", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    resolve.mockResolvedValue({ id: 3, slug: "beta", domain: null, isDefault: false });

    await eventHandler({ input, headers: { host: "beta.example.com" } });

    expect(resolve).toHaveBeenCalledWith("beta.example.com");
    expect(getPublicEvent).toHaveBeenCalledWith({ ...input, org: "beta" }, undefined);
  });

  it("returns no event when the host resolves to no organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    resolve.mockResolvedValue(null);

    const result = await eventHandler({ input, headers: { host: "unknown.example.com" } });

    expect(result).toBeNull();
    expect(getPublicEvent).not.toHaveBeenCalled();
  });
});
