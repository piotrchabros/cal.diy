import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveUsernameNamespace } from "./resolveUsernameNamespace";

describe("resolveUsernameNamespace", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("when organizations are enabled", () => {
    it.each([
      [{ organizationId: 7, legacyOrgSlug: "acme" }, { organizationId: 7 }],
      [{ organizationId: 7, legacyOrgSlug: null }, { organizationId: 7 }],
      [{ organizationId: 7 }, { organizationId: 7 }],
      [{ organizationId: null, legacyOrgSlug: "acme" }, null],
      [{ organizationId: undefined, legacyOrgSlug: "acme" }, null],
      [{ organizationId: null, legacyOrgSlug: null }, null],
      [{ organizationId: undefined }, null],
    ])("resolves %o to %o", (params, expected) => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
      expect(resolveUsernameNamespace(params)).toEqual(expected);
    });
  });

  describe("when organizations are disabled", () => {
    it.each([
      [{ organizationId: 7, legacyOrgSlug: "acme" }, { orgSlug: "acme" }],
      [{ organizationId: null, legacyOrgSlug: "acme" }, { orgSlug: "acme" }],
      [{ organizationId: undefined, legacyOrgSlug: "acme" }, { orgSlug: "acme" }],
      [{ organizationId: 7, legacyOrgSlug: null }, null],
      [{ organizationId: 7 }, null],
      [{ organizationId: null, legacyOrgSlug: "" }, null],
      [{ organizationId: undefined }, null],
    ])("resolves %o to %o", (params, expected) => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
      expect(resolveUsernameNamespace(params)).toEqual(expected);
    });
  });
});
