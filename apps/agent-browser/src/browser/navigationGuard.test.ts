import { describe, expect, it, vi } from "vitest";
import { createDefaultNavigationPolicy, NavigationGuard } from "./navigationGuard";
import type { HostLookup } from "./urlPolicy";

const publicLookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup: HostLookup = async () => [{ address: "10.0.0.5", family: 4 }];

function guardWith(lookup: HostLookup, options: { now?: () => number; max?: number } = {}) {
  const spy = vi.fn(lookup);
  const guard = new NavigationGuard({
    policy: createDefaultNavigationPolicy(spy),
    now: options.now,
    maxNavigationsPerMinute: options.max,
  });
  return { guard, lookup: spy };
}

const navigation = (url: string, isMainFrame = true) => ({ url, isNavigation: true, isMainFrame });

describe("NavigationGuard", () => {
  describe("checkTarget", () => {
    it("allows about:blank without any lookup", async () => {
      const { guard, lookup } = guardWith(publicLookup);
      await expect(guard.checkTarget("about:blank")).resolves.toEqual({ allowed: true });
      expect(lookup).not.toHaveBeenCalled();
    });

    it.each([
      "file:///etc/passwd",
      "chrome://settings",
      "javascript:alert(1)",
      "data:text/html,hi",
      "about:config",
    ])("blocks %s", async (url) => {
      const { guard } = guardWith(publicLookup);
      await expect(guard.checkTarget(url)).resolves.toMatchObject({ allowed: false, code: "BLOCKED_URL" });
    });

    it("blocks a public name that resolves to a private address", async () => {
      const { guard } = guardWith(privateLookup);
      await expect(guard.checkTarget("https://example.com/")).resolves.toEqual({
        allowed: false,
        code: "BLOCKED_URL",
        message: "This address cannot be opened: host resolves to a private address.",
      });
    });

    it("allows a public host", async () => {
      const { guard } = guardWith(publicLookup);
      await expect(guard.checkTarget("https://example.com/")).resolves.toEqual({ allowed: true });
    });
  });

  describe("checkRequest", () => {
    it("checks subresources without resolving their host", async () => {
      const { guard, lookup } = guardWith(privateLookup);
      const request = { url: "https://cdn.example.com/a.png", isNavigation: false, isMainFrame: true };
      await expect(guard.checkRequest(request)).resolves.toEqual({ allowed: true });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("blocks subresources on private literals and local names", async () => {
      const { guard } = guardWith(publicLookup);
      for (const url of ["http://127.0.0.1/x", "http://169.254.169.254/latest", "http://db.internal/"]) {
        await expect(
          guard.checkRequest({ url, isNavigation: false, isMainFrame: true })
        ).resolves.toMatchObject({ allowed: false });
      }
    });

    it("resolves the host of navigations, including iframes", async () => {
      const { guard } = guardWith(privateLookup);
      await expect(guard.checkRequest(navigation("https://example.com/", false))).resolves.toMatchObject({
        allowed: false,
        code: "BLOCKED_URL",
      });
    });

    it("limits main-frame navigations per minute", async () => {
      const clock = { now: 0 };
      const { guard } = guardWith(publicLookup, { now: () => clock.now, max: 3 });

      for (let i = 0; i < 3; i++) {
        await expect(guard.checkRequest(navigation("https://example.com/"))).resolves.toEqual({
          allowed: true,
        });
      }
      await expect(guard.checkRequest(navigation("https://example.com/"))).resolves.toMatchObject({
        allowed: false,
        code: "ACTION_FAILED",
      });

      clock.now = 60_000;
      await expect(guard.checkRequest(navigation("https://example.com/"))).resolves.toEqual({
        allowed: true,
      });
    });

    it("does not count iframe navigations or blocked ones", async () => {
      const { guard } = guardWith(publicLookup, { max: 1 });
      await guard.checkRequest(navigation("https://example.com/", false));
      await guard.checkRequest(navigation("http://localhost/"));
      await expect(guard.checkRequest(navigation("https://example.com/"))).resolves.toEqual({
        allowed: true,
      });
    });
  });

  describe("checkCommittedUrl", () => {
    it("allows the blank page and Chromium's error page", async () => {
      const { guard } = guardWith(privateLookup);
      await expect(guard.checkCommittedUrl("about:blank")).resolves.toEqual({ allowed: true });
      await expect(guard.checkCommittedUrl("chrome-error://chromewebdata/")).resolves.toEqual({
        allowed: true,
      });
    });

    it("blocks a redirect target on a local or privately resolving host", async () => {
      const { guard } = guardWith(privateLookup);
      await expect(guard.checkCommittedUrl("http://localhost:8080/")).resolves.toMatchObject({
        allowed: false,
      });
      await expect(guard.checkCommittedUrl("https://example.com/")).resolves.toMatchObject({
        allowed: false,
      });
    });

    it("reports a failed lookup as a block", async () => {
      const { guard } = guardWith(async () => {
        throw new Error("ENOTFOUND");
      });
      await expect(guard.checkCommittedUrl("https://nowhere.example/")).resolves.toEqual({
        allowed: false,
        code: "BLOCKED_URL",
        message: "This address cannot be opened: host could not be resolved.",
      });
    });
  });
});
