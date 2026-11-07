import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateUsernameSuggestion, usernameCheck, usernameCheckForSignup } from "./username";

describe("usernameCheckForSignup ", async () => {
  beforeEach(() => {
    // @ts-expect-error
    prismaMock.user.findUnique.mockImplementation(() => {
      return null;
    });
    // @ts-expect-error
    prismaMock.user.findMany.mockImplementation(() => {
      return [];
    });
  });

  it("should return available true for an email that doesn't exist", async () => {
    const res = await usernameCheckForSignup({ username: "johnny", email: "johnny@example.com" });
    expect(res).toEqual({
      available: true,
      premium: false,
      suggestedUsername: "",
    });
  });

  it("should return available false for an email that exists and a different username is provided", async () => {
    mockUserInDB({
      id: 1,
      email: "john@example.com",
      username: "john",
    });
    const res = await usernameCheckForSignup({ username: "johnny", email: "john@example.com" });
    expect(res).toEqual({
      available: false,
      premium: false,
      suggestedUsername: "johnny001",
    });
  });

  it("should return available true for an email that exists but the user is signing up for an organization", async () => {
    const userId = 1;
    mockUserInDB({
      id: userId,
      email: "john@example.com",
      username: "john",
    });
    mockMembership({ userId });
    const res = await usernameCheckForSignup({ username: "john", email: "john@example.com" });
    expect(res).toEqual({
      available: true,
      // An organization can't have premium username
      premium: false,
      suggestedUsername: "",
    });
  });
});

describe("usernameCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error
    prismaMock.user.findFirst.mockResolvedValue(null);
    // @ts-expect-error
    prismaMock.user.findMany.mockResolvedValue([]);
    // @ts-expect-error
    prismaMock.tempOrgRedirect.findUnique.mockResolvedValue(null);
    // @ts-expect-error
    prismaMock.team.findFirst.mockResolvedValue(null);
  });

  it("scopes to the given organizationId without resolving a slug or checking migration reservations", async () => {
    const res = await usernameCheck("john", { organizationId: 7 });

    expect(res).toEqual({ available: true, premium: false, suggestedUsername: "" });
    expect(prismaMock.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: "john", organizationId: 7 } })
    );
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: { contains: "john" }, organizationId: 7 } })
    );
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.tempOrgRedirect.findUnique).not.toHaveBeenCalled();
  });

  it("scopes to the global namespace and runs the migration reservation check when namespace is null", async () => {
    // @ts-expect-error
    prismaMock.tempOrgRedirect.findUnique.mockResolvedValue({ id: 1 });

    const res = await usernameCheck("john", null);

    expect(res.available).toBe(false);
    expect(prismaMock.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: "john" } })
    );
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: { contains: "john" } } })
    );
    expect(prismaMock.tempOrgRedirect.findUnique).toHaveBeenCalled();
    expect(prismaMock.team.findFirst).not.toHaveBeenCalled();
  });

  it("defaults to the global namespace when no namespace is passed", async () => {
    const res = await usernameCheck("john");

    expect(res.available).toBe(true);
    expect(prismaMock.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: "john" } })
    );
    expect(prismaMock.tempOrgRedirect.findUnique).toHaveBeenCalled();
  });

  it("resolves the organization from orgSlug and scopes to it", async () => {
    // @ts-expect-error
    prismaMock.team.findFirst.mockResolvedValue({ id: 12 });

    const res = await usernameCheck("john", { orgSlug: "acme" });

    expect(res.available).toBe(true);
    expect(prismaMock.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isOrganization: true,
          OR: [{ slug: "acme" }, { metadata: { path: ["requestedSlug"], equals: "acme" } }],
        },
      })
    );
    expect(prismaMock.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: "john", organizationId: 12 } })
    );
    expect(prismaMock.tempOrgRedirect.findUnique).not.toHaveBeenCalled();
  });

  it("throws NotFound when the orgSlug does not match an organization", async () => {
    await expect(usernameCheck("john", { orgSlug: "missing" })).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
  });

  it("suggests an alternative when the username is taken", async () => {
    // @ts-expect-error
    prismaMock.user.findFirst.mockResolvedValue({ id: 3, username: "john" });
    // @ts-expect-error
    prismaMock.user.findMany.mockResolvedValue([{ username: "john" }]);

    const res = await usernameCheck("john", { organizationId: 7 });

    expect(res).toEqual({ available: false, premium: false, suggestedUsername: "john001" });
  });
});

describe("generateUsernameSuggestion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends a zero-padded suffix when the username is free on the first attempt", async () => {
    const suggestion = await generateUsernameSuggestion([], "john");
    expect(suggestion).toBe("john001");
  });

  it("zero-pads a two-digit suffix to a consistent width", async () => {
    // Force the first candidate (john001) to collide so a random suffix is generated,
    // and pin Math.random so the generated suffix is the two-digit number 42.
    // username length >= 2 -> limit 999 -> rand = ceil(1 + random * 998); 40.5/998 -> ceil(41.5) = 42.
    vi.spyOn(Math, "random").mockReturnValue(40.5 / 998);
    const suggestion = await generateUsernameSuggestion(["john001"], "john");
    expect(suggestion).toBe("john042");
  });

  it("zero-pads a three-digit suffix to a consistent width", async () => {
    // 122.5/998 -> ceil(1 + 122.5) = ceil(123.5) = 124.
    vi.spyOn(Math, "random").mockReturnValue(122.5 / 998);
    const suggestion = await generateUsernameSuggestion(["john001"], "john");
    expect(suggestion).toBe("john124");
  });
});

function mockUserInDB({ id, email, username }: { id: number; email: string; username: string }) {
  // @ts-expect-error
  prismaMock.user.findUnique.mockImplementation((arg) => {
    if (arg.where.email === email) {
      return {
        id,
        email,
        username,
      };
    }
    return null;
  });
}

function mockMembership({ userId }: { userId: number }) {
  // @ts-expect-error
  prismaMock.membership.findFirst.mockImplementation((arg) => {
    const isOrganizationWhereClause =
      // @ts-expect-error
      arg?.where?.team?.metadata?.path[0] === "isOrganization" && arg?.where?.team?.metadata?.equals === true;
    if (arg?.where?.userId === userId && isOrganizationWhereClause) {
      return {
        userId,
        teamId: 1,
      };
    }
  });
}
