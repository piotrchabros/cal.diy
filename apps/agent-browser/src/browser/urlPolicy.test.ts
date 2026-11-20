// @vitest-environment node
import { AGENT_BROWSER_MAX_URL_LENGTH } from "@calcom/lib/agentBrowser/contract";
import { describe, expect, it, vi } from "vitest";
import {
  assertPublicHost,
  BlockedHostError,
  checkNavigableUrl,
  type HostLookup,
  isBlockedHostname,
  isPrivateAddress,
} from "./urlPolicy";

const reasonOf = (raw: string): string | null => {
  const result = checkNavigableUrl(raw);
  return result.ok ? null : result.reason;
};

const resolvingTo =
  (...addresses: string[]): HostLookup =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("checkNavigableUrl", () => {
  it("accepts public http and https URLs and returns the parsed URL", () => {
    const result = checkNavigableUrl("https://example.com/path?q=1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.href).toBe("https://example.com/path?q=1");
    expect(checkNavigableUrl("http://93.184.216.34/").ok).toBe(true);
    expect(checkNavigableUrl("http://[2606:4700::1111]/").ok).toBe(true);
  });

  it.each([
    "file:///etc/passwd",
    "chrome://settings",
    "about:blank",
    "data:text/html,hi",
    "javascript:alert(1)",
    "blob:https://example.com/uuid",
    "view-source:https://example.com",
    "ftp://example.com/",
    "ws://example.com/",
  ])("rejects the scheme of %s", (raw) => {
    expect(reasonOf(raw)).toBe("only http and https URLs are allowed");
  });

  it("rejects unparseable input", () => {
    expect(reasonOf("example.com")).toBe("URL is not valid");
    expect(reasonOf("")).toBe("URL is not valid");
  });

  it("rejects embedded credentials", () => {
    expect(reasonOf("https://user:pass@example.com/")).toBe("URLs with embedded credentials are not allowed");
    expect(reasonOf("https://user@example.com/")).toBe("URLs with embedded credentials are not allowed");
  });

  it("enforces the length cap", () => {
    const base = "https://example.com/";
    const atLimit = base + "a".repeat(AGENT_BROWSER_MAX_URL_LENGTH - base.length);

    expect(checkNavigableUrl(atLimit).ok).toBe(true);
    expect(reasonOf(`${atLimit}a`)).toBe(`URL is longer than ${AGENT_BROWSER_MAX_URL_LENGTH} characters`);
  });

  it.each([
    "http://localhost/",
    "http://LOCALHOST:3221/",
    "http://localhost./",
    "http://app.localhost/",
    "http://metadata.google.internal/",
    "http://printer.local/",
    "http://127.0.0.1:3221/",
    "http://0x7f.1/",
    "http://2130706433/",
    "http://10.1.2.3/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
  ])("rejects the local or private target %s", (raw) => {
    expect(reasonOf(raw)).toBe("local and private addresses are not allowed");
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.0.1",
    "169.254.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.168.0.1",
    "192.168.255.255",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
  ])("blocks the IPv4 address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "::",
    "::1",
    "[::1]",
    "fc00::1",
    "fdff:ffff::1",
    "fe80::1",
    "febf::1",
    "::10.0.0.1",
  ])("blocks the IPv6 address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
  ])("blocks the IPv4-mapped private address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.1",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
    "2606:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "fec0::1",
  ])("allows the public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("treats names as not being addresses", () => {
    expect(isPrivateAddress("example.com")).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it("blocks empty and local names but not lookalikes", () => {
    expect(isBlockedHostname("")).toBe(true);
    expect(isBlockedHostname("Foo.LocalHost")).toBe(true);
    expect(isBlockedHostname("svc.internal.")).toBe(true);
    expect(isBlockedHostname("localhost.example.com")).toBe(false);
    expect(isBlockedHostname("mylocal")).toBe(false);
    expect(isBlockedHostname("internal.example.com")).toBe(false);
  });
});

describe("assertPublicHost", () => {
  it("passes a name whose every address is public", async () => {
    await expect(assertPublicHost("example.com", resolvingTo("93.184.216.34", "2606:2800::1"))).resolves.toBe(
      undefined
    );
  });

  it("blocks a name when any resolved address is private", async () => {
    await expect(
      assertPublicHost("rebind.example", resolvingTo("93.184.216.34", "10.0.0.5"))
    ).rejects.toThrow(new BlockedHostError("host resolves to a private address"));
    await expect(assertPublicHost("rebind.example", resolvingTo("::ffff:127.0.0.1"))).rejects.toThrow(
      "host resolves to a private address"
    );
  });

  it("blocks a name that does not resolve", async () => {
    const failing: HostLookup = async () => {
      throw new Error("ENOTFOUND");
    };

    await expect(assertPublicHost("nope.example", failing)).rejects.toThrow("host could not be resolved");
    await expect(assertPublicHost("empty.example", resolvingTo())).rejects.toThrow(
      "host could not be resolved"
    );
  });

  it("blocks local names and private literals without a lookup", async () => {
    const lookup = vi.fn(resolvingTo("93.184.216.34"));

    await expect(assertPublicHost("localhost", lookup)).rejects.toBeInstanceOf(BlockedHostError);
    await expect(assertPublicHost("db.internal", lookup)).rejects.toBeInstanceOf(BlockedHostError);
    await expect(assertPublicHost("[::1]", lookup)).rejects.toBeInstanceOf(BlockedHostError);
    await expect(assertPublicHost("192.168.1.1", lookup)).rejects.toBeInstanceOf(BlockedHostError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("passes a public literal without a lookup", async () => {
    const lookup = vi.fn(resolvingTo("10.0.0.1"));

    await expect(assertPublicHost("8.8.8.8", lookup)).resolves.toBe(undefined);
    await expect(assertPublicHost("[2606:4700::1111]", lookup)).resolves.toBe(undefined);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("looks up the normalized name", async () => {
    const lookup = vi.fn(resolvingTo("93.184.216.34"));

    await assertPublicHost("Example.COM.", lookup);

    expect(lookup).toHaveBeenCalledWith("example.com");
  });
});
