import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import type { NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestWithUsernameStatus } from "./username";
import { usernameCheck, usernameHandler } from "./username";

const { isPremiumUserNameMock } = vi.hoisted(() => ({ isPremiumUserNameMock: vi.fn() }));

vi.mock("@calcom/lib/server/username", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/server/username")>();
  return { ...actual, isPremiumUserName: isPremiumUserNameMock };
});

function mockTakenUsername(username: string) {
  // @ts-expect-error - partial user row
  prismaMock.user.findUnique.mockResolvedValue({ username });
  // @ts-expect-error - partial user rows
  prismaMock.user.findMany.mockResolvedValue([{ username }]);
}

describe("usernameCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isPremiumUserNameMock.mockResolvedValue(false);
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.findMany.mockResolvedValue([]);
  });

  it("queries the global namespace when no organization is given", async () => {
    const res = await usernameCheck("John");

    expect(res).toEqual({ available: true, premium: false, suggestedUsername: "" });
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username_organizationId: { username: "john", organizationId: null } },
      })
    );
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username: { contains: "john" }, organizationId: null },
      })
    );
  });

  it("scopes both queries to the given organization", async () => {
    await usernameCheck("john", 5);

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username_organizationId: { username: "john", organizationId: 5 } },
      })
    );
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username: { contains: "john" }, organizationId: 5 },
      })
    );
  });

  it("returns a suggestion when the username is taken", async () => {
    mockTakenUsername("john");

    const res = await usernameCheck("john", 5);

    expect(res.available).toBe(false);
    expect(res.suggestedUsername).toBe("john001");
  });

  it("flags premium usernames", async () => {
    isPremiumUserNameMock.mockResolvedValue(true);

    const res = await usernameCheck("ceo");

    expect(res).toEqual({ available: true, premium: true, suggestedUsername: "" });
  });
});

describe("usernameHandler", () => {
  const res = {} as NextApiResponse;

  function buildRequest(username: string) {
    return { body: { username } } as RequestWithUsernameStatus;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    isPremiumUserNameMock.mockResolvedValue(false);
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.findMany.mockResolvedValue([]);
  });

  it("sets 200 for an available username and calls the wrapped handler", async () => {
    const handler = vi.fn();
    const req = buildRequest("john");

    await usernameHandler(handler)(req, res);

    expect(req.usernameStatus.statusCode).toBe(200);
    expect(req.usernameStatus.json).toEqual(
      expect.objectContaining({ available: true, premium: false, suggestion: "" })
    );
    expect(handler).toHaveBeenCalledWith(req, res);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username_organizationId: { username: "john", organizationId: null } },
      })
    );
  });

  it("sets 402 for a premium username", async () => {
    isPremiumUserNameMock.mockResolvedValue(true);
    const handler = vi.fn();
    const req = buildRequest("ceo");

    await usernameHandler(handler)(req, res);

    expect(req.usernameStatus.statusCode).toBe(402);
    expect(req.usernameStatus.json.premium).toBe(true);
    expect(handler).toHaveBeenCalledWith(req, res);
  });

  it("sets 418 with a suggestion for a taken username", async () => {
    mockTakenUsername("john");
    const handler = vi.fn();
    const req = buildRequest("john");

    await usernameHandler(handler)(req, res);

    expect(req.usernameStatus.statusCode).toBe(418);
    expect(req.usernameStatus.json.available).toBe(false);
    expect(req.usernameStatus.json.suggestion).toBe("john001");
    expect(handler).toHaveBeenCalledWith(req, res);
  });
});
