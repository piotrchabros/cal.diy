import { WEBAPP_URL } from "@calcom/lib/constants";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppReturnToUrl } from "./getAppReturnToUrl";

describe("getAppReturnToUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to WEBAPP_URL when there is no window", () => {
    vi.stubGlobal("window", undefined);

    expect(getAppReturnToUrl("/event-types/1?tabName=apps")).toBe(`${WEBAPP_URL}/event-types/1?tabName=apps`);
  });

  it("uses the current window origin so org-domain users return to their own domain", () => {
    vi.stubGlobal("window", { location: { origin: "https://acme.example.org" } });

    expect(getAppReturnToUrl("/event-types/1?tabName=apps")).toBe(
      "https://acme.example.org/event-types/1?tabName=apps"
    );
  });
});
