import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock("node:dns/promises", () => ({
  default: { lookup: lookupMock },
}));

vi.mock("@calcom/lib/constants", () => ({
  IS_SELF_HOSTED: false,
  IS_PRODUCTION: false,
}));

import { isSmtpPortAllowed, parseSmtpHost, resolveSmtpHostAddress, SMTP_HOST_ERRORS } from "./smtpHostPolicy";

describe("parseSmtpHost", () => {
  it("trims, lowercases and strips a trailing dot", () => {
    expect(parseSmtpHost("  SMTP.Example.COM. ")).toBe("smtp.example.com");
  });

  it.each(["1.2.3.4", "2001:db8::1"])("accepts IP literal %s", (ip) => {
    expect(parseSmtpHost(ip)).toBe(ip);
  });

  it("strips brackets from IPv6 literals", () => {
    expect(parseSmtpHost("[2001:db8::1]")).toBe("2001:db8::1");
  });

  it.each([
    "",
    "   ",
    "smtp example.com",
    "-smtp.example.com",
    "smtp-.example.com",
    "smtp..example.com",
    "smtp.example.com:587",
    "smtp://example.com",
    "user@example.com",
    "999.1.1.1",
    `${"a".repeat(64)}.example.com`,
  ])("rejects %j", (raw) => {
    expect(parseSmtpHost(raw)).toBeNull();
  });

  it("rejects hostnames longer than 253 characters", () => {
    const label = "a".repeat(63);
    const host = [label, label, label, label].join(".");
    expect(host.length).toBeGreaterThan(253);
    expect(parseSmtpHost(host)).toBeNull();
  });
});

describe("isSmtpPortAllowed", () => {
  it.each([25, 465, 587, 2525])("allows %d", (port) => {
    expect(isSmtpPortAllowed(port)).toBe(true);
  });

  it.each([0, 22, 80, 443, 3306, 6379, 65535])("rejects %d", (port) => {
    expect(isSmtpPortAllowed(port)).toBe(false);
  });
});

describe("resolveSmtpHostAddress", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("returns the first resolved address when all are public", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);

    await expect(resolveSmtpHostAddress("smtp.example.com")).resolves.toEqual({
      ok: true,
      address: "93.184.216.34",
    });
    expect(lookupMock).toHaveBeenCalledWith("smtp.example.com", { all: true });
  });

  it("rejects when any resolved address is private", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    await expect(resolveSmtpHostAddress("smtp.example.com")).resolves.toEqual({
      ok: false,
      error: SMTP_HOST_ERRORS.privateAddress,
    });
  });

  it("rejects IPv4-mapped IPv6 private addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "::ffff:127.0.0.1", family: 6 }]);

    await expect(resolveSmtpHostAddress("smtp.example.com")).resolves.toEqual({
      ok: false,
      error: SMTP_HOST_ERRORS.privateAddress,
    });
  });

  it("allows private addresses when allowPrivate is set", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    await expect(resolveSmtpHostAddress("smtp.internal", { allowPrivate: true })).resolves.toEqual({
      ok: true,
      address: "10.0.0.5",
    });
  });

  it("blocks link-local metadata addresses even when allowPrivate is set", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    await expect(resolveSmtpHostAddress("evil.example.com", { allowPrivate: true })).resolves.toEqual({
      ok: false,
      error: SMTP_HOST_ERRORS.blockedHost,
    });
  });

  it("fails closed on DNS errors", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));

    await expect(resolveSmtpHostAddress("missing.example.com")).resolves.toEqual({
      ok: false,
      error: SMTP_HOST_ERRORS.dnsFailure,
    });
  });

  it("fails closed when DNS returns no addresses", async () => {
    lookupMock.mockResolvedValue([]);

    await expect(resolveSmtpHostAddress("empty.example.com")).resolves.toEqual({
      ok: false,
      error: SMTP_HOST_ERRORS.dnsFailure,
    });
  });

  it("rejects invalid hosts without a DNS lookup", async () => {
    await expect(resolveSmtpHostAddress("not a host")).resolves.toEqual({
      ok: false,
      error: SMTP_HOST_ERRORS.invalidHost,
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([
    "localhost",
    "metadata.google.internal",
  ])("blocks hostname %s without a DNS lookup", async (host) => {
    await expect(resolveSmtpHostAddress(host)).resolves.toEqual({
      ok: false,
      error: SMTP_HOST_ERRORS.blockedHost,
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("checks public IP literals directly without a DNS lookup", async () => {
    await expect(resolveSmtpHostAddress("93.184.216.34")).resolves.toEqual({
      ok: true,
      address: "93.184.216.34",
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([
    "10.1.2.3",
    "192.168.1.10",
    "[::1]",
    "100.64.0.1",
  ])("rejects private IP literal %s", async (host) => {
    const result = await resolveSmtpHostAddress(host);
    expect(result.ok).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("allows a private IP literal when allowPrivate is set", async () => {
    await expect(resolveSmtpHostAddress("127.0.0.1", { allowPrivate: true })).resolves.toEqual({
      ok: true,
      address: "127.0.0.1",
    });
  });

  it("blocks the metadata IP literal even when allowPrivate is set", async () => {
    await expect(resolveSmtpHostAddress("169.254.169.254", { allowPrivate: true })).resolves.toEqual({
      ok: false,
      error: SMTP_HOST_ERRORS.blockedHost,
    });
  });
});
