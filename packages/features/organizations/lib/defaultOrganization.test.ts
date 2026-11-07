import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findDefaultOrganizationId, requireDefaultOrganizationId } from "./defaultOrganization";

const resolveDefault = vi.fn();

vi.mock("../di/OrganizationDomainResolver.container", () => ({
  getOrganizationDomainResolver: () => ({ resolveDefault }),
}));

const defaultOrg = { id: 7, slug: "default", domain: "cal.example.com", isDefault: true };

describe("defaultOrganization", () => {
  beforeEach(() => {
    resolveDefault.mockReset();
  });

  describe("findDefaultOrganizationId", () => {
    it("returns the default org id", async () => {
      resolveDefault.mockResolvedValue(defaultOrg);

      await expect(findDefaultOrganizationId()).resolves.toBe(7);
    });

    it("returns null when there is no default org", async () => {
      resolveDefault.mockResolvedValue(null);

      await expect(findDefaultOrganizationId()).resolves.toBeNull();
    });
  });

  describe("requireDefaultOrganizationId", () => {
    it("returns the default org id", async () => {
      resolveDefault.mockResolvedValue(defaultOrg);

      await expect(requireDefaultOrganizationId()).resolves.toBe(7);
    });

    it("throws a precondition error when there is no default org", async () => {
      resolveDefault.mockResolvedValue(null);

      const error = await requireDefaultOrganizationId().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ErrorWithCode);
      expect(error).toMatchObject({
        code: ErrorCode.PreconditionFailed,
        message: "No default organization: no organization uses the domain of NEXT_PUBLIC_WEBAPP_URL",
      });
    });
  });
});
