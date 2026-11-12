import { APP_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationMailRoute } from "./organizationMailer";
import { deliverOrganizationMail, resolveOrganizationMailRoute } from "./organizationMailer";

const { sendMail, resolveForScope } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  resolveForScope: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail }),
}));

vi.mock("@calcom/features/organizations/di/OrganizationEmailSenderService.container", () => ({
  getOrganizationEmailSenderService: () => ({ resolveForScope }),
}));

const ENV_FROM = "notifications@cal.example";
const systemFrom = `${APP_NAME} <${ENV_FROM}>`;

const sentFroms = () => sendMail.mock.calls.map(([payload]) => payload.from);

describe("resolveOrganizationMailRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("keeps the from header when there is no scope", async () => {
    const route = await resolveOrganizationMailRoute({
      from: systemFrom,
      envFrom: ENV_FROM,
      scope: null,
      logName: "TEST",
    });

    expect(route).toEqual({ from: systemFrom, customized: false, smtp: null });
    expect(resolveForScope).not.toHaveBeenCalled();
  });

  it("keeps the from header when no env sender is configured", async () => {
    const route = await resolveOrganizationMailRoute({
      from: systemFrom,
      envFrom: undefined,
      scope: { organizationId: 1 },
      logName: "TEST",
    });

    expect(route).toEqual({ from: systemFrom, customized: false, smtp: null });
    expect(resolveForScope).not.toHaveBeenCalled();
  });

  it("applies the organization sender", async () => {
    resolveForScope.mockResolvedValue({ name: "Acme", address: "hello@acme.com" });

    const route = await resolveOrganizationMailRoute({
      from: `${EMAIL_FROM_NAME} <${ENV_FROM}>`,
      envFrom: `${EMAIL_FROM_NAME} <${ENV_FROM}>`,
      scope: { userEmail: "a@b.com" },
      logName: "TEST",
    });

    expect(resolveForScope).toHaveBeenCalledWith({ userEmail: "a@b.com" });
    expect(route).toEqual({ from: "Acme <hello@acme.com>", customized: true, smtp: null });
  });

  it("keeps the from header when the organization has no sender settings", async () => {
    resolveForScope.mockResolvedValue(null);

    const route = await resolveOrganizationMailRoute({
      from: systemFrom,
      envFrom: ENV_FROM,
      scope: { organizationId: 1 },
      logName: "TEST",
    });

    expect(route).toEqual({ from: systemFrom, customized: false, smtp: null });
  });

  it("falls back to the original from header when resolving throws", async () => {
    resolveForScope.mockRejectedValue(new Error("db down"));

    const route = await resolveOrganizationMailRoute({
      from: systemFrom,
      envFrom: ENV_FROM,
      scope: { organizationId: 1 },
      logName: "TEST",
    });

    expect(route).toEqual({ from: systemFrom, customized: false, smtp: null });
    expect(console.warn).toHaveBeenCalledWith(
      "TEST: failed to resolve organization email sender, using default",
      expect.any(Error)
    );
  });
});

describe("deliverOrganizationMail", () => {
  const customizedRoute: OrganizationMailRoute = {
    from: "Acme <hello@acme.com>",
    customized: true,
    smtp: null,
  };
  const defaultRoute: OrganizationMailRoute = { from: systemFrom, customized: false, smtp: null };

  beforeEach(() => {
    vi.clearAllMocks();
    sendMail.mockImplementation((_payload, callback) => callback(null, { messageId: "1" }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("sends with the route's sanitized from header", async () => {
    const info = await deliverOrganizationMail({
      payload: { to: "guest@example.com", subject: "Hi" },
      route: { from: "Acme; Inc <hello@acme.com>", customized: true, smtp: null },
      originalFrom: systemFrom,
      defaultTransport: {},
      logName: "TEST",
    });

    expect(info).toEqual({ messageId: "1" });
    expect(sendMail).toHaveBeenCalledWith(
      { to: "guest@example.com", subject: "Hi", from: "Acme Inc <hello@acme.com>" },
      expect.any(Function)
    );
  });

  it("retries once with the original from header when a customized send fails", async () => {
    const onTransportError = vi.fn();
    sendMail
      .mockImplementationOnce((_payload, callback) => callback(new Error("domain not verified")))
      .mockImplementationOnce((_payload, callback) => callback(null, {}));

    await deliverOrganizationMail({
      payload: { to: "guest@example.com" },
      route: customizedRoute,
      originalFrom: systemFrom,
      defaultTransport: {},
      logName: "TEST",
      onTransportError,
    });

    expect(sentFroms()).toEqual(["Acme <hello@acme.com>", systemFrom]);
    expect(onTransportError).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it("throws when the retry with the original from header also fails", async () => {
    sendMail.mockImplementation((_payload, callback) => callback(new Error("smtp down")));

    await expect(
      deliverOrganizationMail({
        payload: { to: "guest@example.com" },
        route: customizedRoute,
        originalFrom: systemFrom,
        defaultTransport: {},
        logName: "TEST",
      })
    ).rejects.toThrow("smtp down");
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("throws without retrying when the from header was not customized", async () => {
    const onTransportError = vi.fn();
    sendMail.mockImplementation((_payload, callback) => callback(new Error("smtp down")));

    await expect(
      deliverOrganizationMail({
        payload: { to: "guest@example.com" },
        route: defaultRoute,
        originalFrom: systemFrom,
        defaultTransport: {},
        logName: "TEST",
        onTransportError,
      })
    ).rejects.toThrow("smtp down");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(onTransportError).toHaveBeenCalledWith(expect.any(Error));
  });
});
