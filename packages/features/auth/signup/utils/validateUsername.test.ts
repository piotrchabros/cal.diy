import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrgUsernameFromEmail } from "./getOrgUsernameFromEmail";
import {
  validateAndGetCorrectedUsernameAndEmail,
  validateAndGetCorrectedUsernameInTeam,
} from "./validateUsername";

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

describe("validateAndGetCorrectedUsernameInTeam", () => {
  const subTeam = {
    isOrganization: false,
    parentId: 11,
    parent: { organizationSettings: { orgAutoAcceptEmail: "acme.com" } },
    organizationSettings: null,
    metadata: null,
  };

  beforeEach(() => {
    prismaMock.user.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats a sub-team as top-level with organizations off and checks the username globally", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "false");
    // @ts-expect-error partial team is enough for the selected fields
    prismaMock.team.findUnique.mockResolvedValue(subTeam);

    const res = await validateAndGetCorrectedUsernameInTeam("john", "john.doe@acme.com", 5, true);

    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ username: "john" }, emailClause("john.doe@acme.com")] },
      select: { email: true },
    });
    expect(res).toEqual({ isValid: true, username: "john", email: undefined });
  });

  it("checks a sub-team in its organization with organizations on", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "true");
    // @ts-expect-error partial team is enough for the selected fields
    prismaMock.team.findUnique.mockResolvedValue(subTeam);

    const res = await validateAndGetCorrectedUsernameInTeam("john", "john.doe@acme.com", 5, true);

    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 11, OR: [{}, emailClause("john.doe@acme.com")] },
      select: { email: true },
    });
    expect(res).toEqual({
      isValid: true,
      username: getOrgUsernameFromEmail("john.doe@acme.com", "acme.com"),
      email: undefined,
    });
  });

  it("keeps the organization check for an organization team with organizations off", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "false");
    // @ts-expect-error partial team is enough for the selected fields
    prismaMock.team.findUnique.mockResolvedValue({
      isOrganization: true,
      parentId: null,
      parent: null,
      organizationSettings: { orgAutoAcceptEmail: "acme.com" },
      metadata: null,
    });

    const res = await validateAndGetCorrectedUsernameInTeam("john", "john.doe@acme.com", 11, true);

    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 11, OR: [{}, emailClause("john.doe@acme.com")] },
      select: { email: true },
    });
    expect(res).toEqual({
      isValid: true,
      username: getOrgUsernameFromEmail("john.doe@acme.com", "acme.com"),
      email: undefined,
    });
  });

  it("checks the username globally for a team without a parent", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "false");
    // @ts-expect-error partial team is enough for the selected fields
    prismaMock.team.findUnique.mockResolvedValue({ ...subTeam, parentId: null, parent: null });

    const res = await validateAndGetCorrectedUsernameInTeam("john", "john@example.com", 5, true);

    expect(prismaMock.user.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ username: "john" }, emailClause("john@example.com")] },
      select: { email: true },
    });
    expect(res).toEqual({ isValid: true, username: "john", email: undefined });
  });
});
