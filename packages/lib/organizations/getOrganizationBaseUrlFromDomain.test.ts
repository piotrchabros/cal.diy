import { describe, expect, it, vi } from "vitest";
import {
  getDefaultOrganizationDomain,
  getOrganizationBaseUrlFromDomain,
} from "./getOrganizationBaseUrlFromDomain";

const constants = vi.hoisted(() => ({ webappUrl: "https://cal.example.com/app" }));

vi.mock("@calcom/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/constants")>();
  return {
    ...actual,
    get WEBAPP_URL() {
      return constants.webappUrl;
    },
  };
});

const DEFAULT_DOMAIN = "cal.example.com";

describe("getOrganizationBaseUrlFromDomain", () => {
  it("returns WEBAPP_URL when the domain is missing", () => {
    expect(getOrganizationBaseUrlFromDomain(null, DEFAULT_DOMAIN)).toBe(constants.webappUrl);
    expect(getOrganizationBaseUrlFromDomain(undefined, DEFAULT_DOMAIN)).toBe(constants.webappUrl);
    expect(getOrganizationBaseUrlFromDomain("   ", DEFAULT_DOMAIN)).toBe(constants.webappUrl);
  });

  it("returns WEBAPP_URL, path included, for the default domain", () => {
    expect(getOrganizationBaseUrlFromDomain("cal.example.com", DEFAULT_DOMAIN)).toBe(
      "https://cal.example.com/app"
    );
  });

  it("normalizes the domain before comparing it with the default domain", () => {
    expect(getOrganizationBaseUrlFromDomain(" CAL.Example.com. ", DEFAULT_DOMAIN)).toBe(constants.webappUrl);
  });

  it("returns WEBAPP_URL for loopback domains", () => {
    expect(getOrganizationBaseUrlFromDomain("localhost", DEFAULT_DOMAIN)).toBe(constants.webappUrl);
    expect(getOrganizationBaseUrlFromDomain("127.0.0.1:3000", DEFAULT_DOMAIN)).toBe(constants.webappUrl);
  });

  it("builds an origin on the webapp scheme for a custom domain", () => {
    expect(getOrganizationBaseUrlFromDomain("Cal.BespokeSoft.pl", DEFAULT_DOMAIN)).toBe(
      "https://cal.bespokesoft.pl"
    );
  });

  it("keeps the webapp port for a custom domain", () => {
    constants.webappUrl = "http://bluebee.test:3747";
    try {
      expect(getOrganizationBaseUrlFromDomain("bespoke.test", "bluebee.test")).toBe(
        "http://bespoke.test:3747"
      );
    } finally {
      constants.webappUrl = "https://cal.example.com/app";
    }
  });

  it("builds an origin for any domain when there is no default domain", () => {
    expect(getOrganizationBaseUrlFromDomain("cal.example.com", null)).toBe("https://cal.example.com");
  });
});

describe("getDefaultOrganizationDomain", () => {
  it("returns the normalized host of the given webapp URL without port or path", () => {
    expect(getDefaultOrganizationDomain("http://Bluebee.test:3747/app")).toBe("bluebee.test");
  });

  it("defaults to the host of WEBAPP_URL", () => {
    expect(getDefaultOrganizationDomain()).toBe("cal.example.com");
  });
});
