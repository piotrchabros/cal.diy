import { afterEach, describe, expect, it, vi } from "vitest";
import { isOrganizationsEnabled } from "./isOrganizationsEnabled";
import { isLoopbackHost, normalizeHost } from "./normalizeHost";
import { outsideOrganizationsFilter } from "./outsideOrganizationsFilter";

describe("isOrganizationsEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["1", "true"])("returns true when ORGANIZATIONS_ENABLED is %s", (value) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", value);
    expect(isOrganizationsEnabled()).toBe(true);
  });

  it("returns false when ORGANIZATIONS_ENABLED is unset", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", undefined);
    expect(isOrganizationsEnabled()).toBe(false);
  });

  it.each(["0", "false", "TRUE"])("returns false when ORGANIZATIONS_ENABLED is %s", (value) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", value);
    expect(isOrganizationsEnabled()).toBe(false);
  });

  it("reads the environment on each call", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "0");
    expect(isOrganizationsEnabled()).toBe(false);
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    expect(isOrganizationsEnabled()).toBe(true);
  });
});

describe("outsideOrganizationsFilter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["1", "true"])("returns the filter when ORGANIZATIONS_ENABLED is %s", (value) => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", value);
    expect(outsideOrganizationsFilter({ organizationId: null })).toEqual({ organizationId: null });
  });

  it("returns an empty filter when ORGANIZATIONS_ENABLED is unset", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", undefined);
    expect(outsideOrganizationsFilter({ organizationId: null })).toEqual({});
  });

  it("returns an empty filter when ORGANIZATIONS_ENABLED is 0", () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "0");
    expect(outsideOrganizationsFilter({ organizationId: null })).toEqual({});
  });
});

describe("normalizeHost", () => {
  it.each([
    ["Cal.Example.COM:3000", "cal.example.com"],
    ["example.com.", "example.com"],
    ["[::1]:3000", "[::1]"],
    ["::1", "::1"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  it.each(["", "  ", null, undefined])("returns null for %j", (input) => {
    expect(normalizeHost(input)).toBeNull();
  });
});

describe("isLoopbackHost", () => {
  it.each(["localhost:3000", "127.0.0.1", "[::1]:80"])("returns true for %s", (input) => {
    expect(isLoopbackHost(input)).toBe(true);
  });

  it.each(["cal.bluebee.marketing", null])("returns false for %j", (input) => {
    expect(isLoopbackHost(input)).toBe(false);
  });
});
