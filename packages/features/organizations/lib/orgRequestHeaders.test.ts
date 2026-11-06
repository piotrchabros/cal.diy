import { describe, expect, it } from "vitest";
import {
  ORG_DOMAIN_HEADER,
  ORG_ID_HEADER,
  ORG_IS_DEFAULT_HEADER,
  ORG_SLUG_HEADER,
  readOrgFromHeaders,
  setOrgHeaders,
  stripOrgHeaders,
  toHeaderGetter,
} from "./orgRequestHeaders";

describe("toHeaderGetter", () => {
  it("looks up the lower-cased header name", () => {
    const getter = toHeaderGetter({ host: "cal.acme.com" });

    expect(getter.get("Host")).toBe("cal.acme.com");
    expect(getter.get("HOST")).toBe("cal.acme.com");
  });

  it("joins array values with a comma", () => {
    const getter = toHeaderGetter({ "x-forwarded-for": ["1.1.1.1", "2.2.2.2"] });

    expect(getter.get("x-forwarded-for")).toBe("1.1.1.1, 2.2.2.2");
  });

  it("returns null for a missing header", () => {
    const getter = toHeaderGetter({ host: undefined });

    expect(getter.get("host")).toBeNull();
    expect(getter.get("x-missing")).toBeNull();
  });

  it("round-trips through readOrgFromHeaders", () => {
    const getter = toHeaderGetter({
      [ORG_ID_HEADER]: "5",
      [ORG_SLUG_HEADER]: "acme",
      [ORG_DOMAIN_HEADER]: "cal.acme.com",
      [ORG_IS_DEFAULT_HEADER]: "0",
    });

    expect(readOrgFromHeaders(getter)).toEqual({
      id: 5,
      slug: "acme",
      domain: "cal.acme.com",
      isDefault: false,
    });
  });
});

describe("setOrgHeaders / stripOrgHeaders", () => {
  it("replaces client-supplied organization headers", () => {
    const headers = new Headers({ [ORG_ID_HEADER]: "999", [ORG_SLUG_HEADER]: "spoofed" });

    setOrgHeaders(headers, { id: 3, slug: null, domain: "cal.acme.com", isDefault: true });

    expect(readOrgFromHeaders(headers)).toEqual({
      id: 3,
      slug: null,
      domain: "cal.acme.com",
      isDefault: true,
    });
  });

  it("removes every organization header", () => {
    const headers = new Headers({
      [ORG_ID_HEADER]: "1",
      [ORG_SLUG_HEADER]: "acme",
      [ORG_DOMAIN_HEADER]: "cal.acme.com",
      [ORG_IS_DEFAULT_HEADER]: "1",
    });

    stripOrgHeaders(headers);

    expect([...headers.keys()]).toEqual([]);
    expect(readOrgFromHeaders(headers)).toBeNull();
  });
});
