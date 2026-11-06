import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import { beforeEach, describe, expect, it } from "vitest";
import { getOrgUsernameFromEmail } from "./getOrgUsernameFromEmail";
import { validateAndGetCorrectedUsernameAndEmail } from "./validateUsername";

const emailClause = (email: string) => ({
  AND: [
    { email },
    {
      OR: [
        { emailVerified: { not: null } },
        { AND: [{ password: { isNot: null } }, { username: { not: null } }] },
      ],
    },
  ],
});

describe("validateAndGetCorrectedUsernameAndEmail", () => {
  beforeEach(() => {
    prismaMock.user.findFirst.mockResolvedValue(null);
  });

  it("checks the username globally when no organization is given", async () => {
    const res = await validateAndGetCorrectedUsernameAndEmail({
      username: "john",
      email: "john@example.com",
      isSignup: true,
    });

    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ username: "john" }, emailClause("john@example.com")] },
      select: { email: true },
    });
    expect(res).toEqual({ isValid: true, username: "john", email: undefined });
  });

  it("scopes only the username clause with usernameOrganizationId and keeps the username", async () => {
    const res = await validateAndGetCorrectedUsernameAndEmail({
      username: "john",
      email: "john@acme.com",
      isSignup: true,
      usernameOrganizationId: 7,
    });

    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ username: "john", organizationId: 7 }, emailClause("john@acme.com")] },
      select: { email: true },
    });
    expect(res).toEqual({ isValid: true, username: "john", email: undefined });
  });

  it("filters by organizationId and derives the username from the email", async () => {
    const res = await validateAndGetCorrectedUsernameAndEmail({
      username: "john",
      email: "john.doe@acme.com",
      organizationId: 7,
      orgAutoAcceptEmail: "acme.com",
      isSignup: true,
    });

    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 7, OR: [{}, emailClause("john.doe@acme.com")] },
      select: { email: true },
    });
    expect(res).toEqual({
      isValid: true,
      username: getOrgUsernameFromEmail("john.doe@acme.com", "acme.com"),
      email: undefined,
    });
  });

  it("rejects a username containing '+' without querying", async () => {
    const res = await validateAndGetCorrectedUsernameAndEmail({
      username: "john+1",
      email: "john@example.com",
      isSignup: true,
    });

    expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
    expect(res).toEqual({ isValid: false, username: undefined, email: "john@example.com" });
  });

  it("is invalid when a matching user exists", async () => {
    // @ts-expect-error partial user is enough for the selected fields
    prismaMock.user.findFirst.mockResolvedValue({ email: "john@example.com" });

    const res = await validateAndGetCorrectedUsernameAndEmail({
      username: "john",
      email: "john@example.com",
      isSignup: true,
      usernameOrganizationId: 7,
    });

    expect(res).toEqual({ isValid: false, username: "john", email: "john@example.com" });
  });
});
