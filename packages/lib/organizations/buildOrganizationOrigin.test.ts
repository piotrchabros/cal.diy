import { WEBAPP_URL } from "@calcom/lib/constants";
import { describe, expect, it } from "vitest";
import { buildOrganizationOrigin } from "./buildOrganizationOrigin";

describe("buildOrganizationOrigin", () => {
  it("uses https without a port for a production webapp URL", () => {
    expect(buildOrganizationOrigin("bespoke.test", "https://cal.bluebee.marketing")).toBe(
      "https://bespoke.test"
    );
  });

  it("keeps the http scheme and dev port of a local multi-domain webapp URL", () => {
    expect(buildOrganizationOrigin("bespoke.test", "http://bluebee.test:3747")).toBe(
      "http://bespoke.test:3747"
    );
  });

  it("keeps the port of a localhost webapp URL", () => {
    expect(buildOrganizationOrigin("bespoke.test", "http://localhost:3000")).toBe("http://bespoke.test:3000");
  });

  it("drops the path of the webapp URL", () => {
    expect(buildOrganizationOrigin("bespoke.test", "https://cal.example.com/app/")).toBe(
      "https://bespoke.test"
    );
  });

  it("omits explicit default ports", () => {
    expect(buildOrganizationOrigin("bespoke.test", "https://cal.example.com:443")).toBe(
      "https://bespoke.test"
    );
    expect(buildOrganizationOrigin("bespoke.test", "http://cal.example.com:80")).toBe("http://bespoke.test");
  });

  it("defaults to the scheme and port of WEBAPP_URL", () => {
    const { protocol, port } = new URL(WEBAPP_URL);
    expect(buildOrganizationOrigin("bespoke.test")).toBe(
      `${protocol}//bespoke.test${port ? `:${port}` : ""}`
    );
  });
});
