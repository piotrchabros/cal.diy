import type { NextApiRequest } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLinkStep } from "./link";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    credential: { findFirst: vi.fn() },
    team: { findUnique: vi.fn(), findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    eventType: { findMany: vi.fn() },
  },
}));

vi.mock("@calcom/prisma", () => ({
  default: prismaMock,
  prisma: prismaMock,
}));

vi.mock("@calcom/lib/constants", () => ({
  WEBAPP_URL: "https://app.example.com",
}));

vi.mock("../../lib/isValidCalURL", () => ({
  isValidCalURL: vi.fn().mockResolvedValue({ isValid: false, error: undefined }),
}));

const req = { body: { admin: { id: "admin-1" }, component_id: undefined } } as unknown as NextApiRequest;

const getItemIds = (result: Awaited<ReturnType<typeof handleLinkStep>>): string[] => {
  if (typeof result === "string") throw new Error(`Expected a canvas, got ${result}`);
  const [list] = result.canvas.content.components;
  if (!("items" in list)) throw new Error("Expected the first component to be the event type list");
  return list.items.map((item) => item.id);
};

describe("handleLinkStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.eventType.findMany.mockResolvedValue([{ slug: "30min", title: "30 min" }]);
    prismaMock.team.findFirst.mockResolvedValue({
      organizationSettings: { customDomain: "acme.example.org" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("links to WEBAPP_URL when organizations are disabled", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    prismaMock.credential.findFirst.mockResolvedValue({ teamId: null, userId: 1 });
    prismaMock.user.findUnique.mockResolvedValue({ id: 1, username: "alice", organizationId: 10 });

    const ids = getItemIds(await handleLinkStep(req));

    expect(ids).toEqual(["https://app.example.com/alice/30min"]);
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });

  it("links an organization member to the organization's origin", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.credential.findFirst.mockResolvedValue({ teamId: null, userId: 1 });
    prismaMock.user.findUnique.mockResolvedValue({ id: 1, username: "alice", organizationId: 10 });

    const ids = getItemIds(await handleLinkStep(req));

    expect(ids).toEqual(["https://acme.example.org/alice/30min"]);
    expect(prismaMock.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 10, isOrganization: true, parentId: null } })
    );
  });

  it("links a team to its parent organization's origin", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.credential.findFirst.mockResolvedValue({ teamId: 5, userId: null });
    prismaMock.team.findUnique.mockResolvedValue({
      id: 5,
      slug: "sales",
      parentId: 20,
      isOrganization: false,
    });

    const ids = getItemIds(await handleLinkStep(req));

    expect(ids).toEqual(["https://acme.example.org/team/sales/30min"]);
    expect(prismaMock.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 20, isOrganization: true, parentId: null } })
    );
  });

  it("falls back to WEBAPP_URL when the user has no organization", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    prismaMock.credential.findFirst.mockResolvedValue({ teamId: null, userId: 1 });
    prismaMock.user.findUnique.mockResolvedValue({ id: 1, username: "alice", organizationId: null });

    const ids = getItemIds(await handleLinkStep(req));

    expect(ids).toEqual(["https://app.example.com/alice/30min"]);
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });
});
