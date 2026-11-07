import type { Request } from "express";
import { extractUserContext } from "./extract-user-context";

function requestWithProfile(organizationId: number, isPlatform: boolean): Request {
  return {
    user: {
      id: 7,
      email: "alice@example.com",
      profiles: [{ id: 10, organizationId, organization: { id: organizationId, isPlatform } }],
    },
  } as unknown as Request;
}

describe("extractUserContext userOrgId", () => {
  const originalFlag = process.env.ORGANIZATIONS_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.ORGANIZATIONS_ENABLED;
    } else {
      process.env.ORGANIZATIONS_ENABLED = originalFlag;
    }
  });

  it("omits the switch-over BlueBee organization when organizations are disabled", () => {
    process.env.ORGANIZATIONS_ENABLED = "";

    const context = extractUserContext(requestWithProfile(1, false));
    expect(context.userId).toBe("7");
    expect(context.userOrgId).toBeUndefined();
  });

  it("sets the organization when organizations are enabled", () => {
    process.env.ORGANIZATIONS_ENABLED = "true";

    expect(extractUserContext(requestWithProfile(1, false)).userOrgId).toBe("1");
  });

  it("keeps platform organizations when organizations are disabled", () => {
    process.env.ORGANIZATIONS_ENABLED = "";

    expect(extractUserContext(requestWithProfile(2, true)).userOrgId).toBe("2");
  });
});
