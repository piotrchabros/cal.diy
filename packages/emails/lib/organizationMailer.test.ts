import { APP_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type { OrganizationSmtpTransportConfig } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationMailRoute } from "./organizationMailer";
import { deliverOrganizationMail, resolveOrganizationMailRoute } from "./organizationMailer";

const { sendMail, createTransport, resolveDeliveryForScope, resolveSmtpHostAddress } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return {
    sendMail,
    createTransport: vi.fn(() => ({ sendMail })),
    resolveDeliveryForScope: vi.fn(),
    resolveSmtpHostAddress: vi.fn(),
  };
});

vi.mock("nodemailer", () => ({ createTransport }));

vi.mock("@calcom/lib/smtp/smtpHostPolicy", () => ({ resolveSmtpHostAddress }));

vi.mock("@calcom/features/organizations/di/OrganizationEmailSenderService.container", () => ({
  getOrganizationEmailSenderService: () => ({ resolveDeliveryForScope }),
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
    expect(resolveDeliveryForScope).not.toHaveBeenCalled();
  });

  it("keeps the from header when no env sender is configured", async () => {
    const route = await resolveOrganizationMailRoute({
      from: systemFrom,
      envFrom: undefined,
      scope: { organizationId: 1 },
      logName: "TEST",
    });

    expect(route).toEqual({ from: systemFrom, customized: false, smtp: null });
    expect(resolveDeliveryForScope).not.toHaveBeenCalled();
  });

  it("applies the organization sender", async () => {
    resolveDeliveryForScope.mockResolvedValue({
      sender: { name: "Acme", address: "hello@acme.com" },
      smtp: null,
    });

    const route = await resolveOrganizationMailRoute({
      from: `${EMAIL_FROM_NAME} <${ENV_FROM}>`,
      envFrom: `${EMAIL_FROM_NAME} <${ENV_FROM}>`,
      scope: { userEmail: "a@b.com" },
      logName: "TEST",
    });

    expect(resolveDeliveryForScope).toHaveBeenCalledWith({ userEmail: "a@b.com" });
    expect(route).toEqual({ from: "Acme <hello@acme.com>", customized: true, smtp: null });
  });

  it("keeps the from header when the organization has no sender settings", async () => {
    resolveDeliveryForScope.mockResolvedValue(null);

    const route = await resolveOrganizationMailRoute({
      from: systemFrom,
      envFrom: ENV_FROM,
      scope: { organizationId: 1 },
      logName: "TEST",
    });

    expect(route).toEqual({ from: systemFrom, customized: false, smtp: null });
  });

  it("falls back to the original from header when resolving throws", async () => {
    resolveDeliveryForScope.mockRejectedValue(new Error("db down"));

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

describe("organization SMTP delivery", () => {
  const PASSWORD = "s3cret-pass";
  const orgSendMail = vi.fn();
  const orgTransporters: { sendMail: typeof orgSendMail; close: ReturnType<typeof vi.fn> }[] = [];
  let nextOrganizationId = 100;

  const smtpConfig = (overrides: Partial<OrganizationSmtpTransportConfig> = {}) => ({
    organizationId: nextOrganizationId++,
    version: "2026-01-01T00:00:00.000Z",
    host: "smtp.acme.com",
    port: 587,
    security: "STARTTLS" as const,
    username: "mailer-auth@acme.com",
    password: PASSWORD,
    ...overrides,
  });

  const smtpRoute = (smtp: OrganizationSmtpTransportConfig): OrganizationMailRoute => ({
    from: "Acme <hello@acme.com>",
    customized: true,
    smtp,
  });

  const deliver = (route: OrganizationMailRoute, onTransportError?: (error: Error) => void) =>
    deliverOrganizationMail({
      payload: { to: "guest@example.com", subject: "Hi" },
      route,
      originalFrom: systemFrom,
      defaultTransport: {},
      logName: "TEST",
      onTransportError,
    });

  const allConsoleOutput = () =>
    JSON.stringify(
      [console.warn, console.error, console.log, console.info].flatMap(
        (fn) => (fn as ReturnType<typeof vi.fn>).mock.calls
      ),
      (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value)
    );

  beforeEach(() => {
    vi.clearAllMocks();
    orgTransporters.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    sendMail.mockImplementation((_payload, callback) => callback(null, { messageId: "default" }));
    orgSendMail.mockImplementation((_payload, callback) => callback(null, { messageId: "org" }));
    resolveSmtpHostAddress.mockResolvedValue({ ok: true, address: "203.0.113.10" });
    createTransport.mockImplementation((options?: { host?: string }) => {
      if (!options?.host) return { sendMail };
      const transporter = { sendMail: orgSendMail, close: vi.fn() };
      orgTransporters.push(transporter);
      return transporter;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("routes through the organization SMTP with the organization sender name and address", async () => {
    const smtp = smtpConfig();
    resolveDeliveryForScope.mockResolvedValue({ sender: { name: "Acme", address: "hello@acme.com" }, smtp });

    const route = await resolveOrganizationMailRoute({
      from: systemFrom,
      envFrom: ENV_FROM,
      scope: { organizationId: smtp.organizationId },
      logName: "TEST",
    });

    expect(route).toEqual({ from: "Acme <hello@acme.com>", customized: true, smtp });
  });

  it("keeps the organizer name when routing through the organization SMTP", async () => {
    const smtp = smtpConfig();
    resolveDeliveryForScope.mockResolvedValue({ sender: { name: "Acme", address: "hello@acme.com" }, smtp });

    const route = await resolveOrganizationMailRoute({
      from: `Jane Host <${ENV_FROM}>`,
      envFrom: ENV_FROM,
      scope: { userId: 7 },
      logName: "TEST",
    });

    expect(route.from).toBe("Jane Host <hello@acme.com>");
    expect(route.smtp).toBe(smtp);
  });

  it("sends through the organization transporter with the alias from header", async () => {
    const smtp = smtpConfig();

    const info = await deliver(smtpRoute(smtp));

    expect(info).toEqual({ messageId: "org" });
    expect(resolveSmtpHostAddress).toHaveBeenCalledWith("smtp.acme.com", { allowPrivate: false });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "203.0.113.10",
        port: 587,
        auth: { user: "mailer-auth@acme.com", pass: PASSWORD },
        tls: expect.objectContaining({ servername: "smtp.acme.com" }),
      })
    );
    expect(orgSendMail).toHaveBeenCalledWith(
      { to: "guest@example.com", subject: "Hi", from: "Acme <hello@acme.com>" },
      expect.any(Function)
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("allows private hosts only when the env flag is set", async () => {
    vi.stubEnv("ORGANIZATION_SMTP_ALLOW_PRIVATE_HOSTS", "true");

    await deliver(smtpRoute(smtpConfig()));

    expect(resolveSmtpHostAddress).toHaveBeenCalledWith("smtp.acme.com", { allowPrivate: true });
  });

  it("falls back to the default transport with the env sender when the SMTP send fails", async () => {
    const onTransportError = vi.fn();
    const smtp = smtpConfig();
    orgSendMail.mockImplementation((_payload, callback) =>
      callback(Object.assign(new Error(`Invalid login: ${PASSWORD}`), { code: "EAUTH" }))
    );

    const info = await deliver(smtpRoute(smtp), onTransportError);

    expect(info).toEqual({ messageId: "default" });
    expect(sentFroms()).toEqual([systemFrom]);
    expect(onTransportError).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), {
      organizationId: smtp.organizationId,
      code: "EAUTH",
    });
  });

  it("falls back to the default transport when the host fails the policy check", async () => {
    const smtp = smtpConfig();
    resolveSmtpHostAddress.mockResolvedValue({ ok: false, error: "organization_smtp_host_private" });

    await deliver(smtpRoute(smtp));

    expect(orgTransporters).toHaveLength(0);
    expect(sentFroms()).toEqual([systemFrom]);
    expect(console.warn).toHaveBeenCalledWith(expect.any(String), {
      organizationId: smtp.organizationId,
      code: "organization_smtp_host_private",
    });
  });

  it("throws when the default transport fallback also fails", async () => {
    orgSendMail.mockImplementation((_payload, callback) => callback(new Error("org down")));
    sendMail.mockImplementation((_payload, callback) => callback(new Error("smtp down")));

    await expect(deliver(smtpRoute(smtpConfig()))).rejects.toThrow("smtp down");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached transporter within the TTL", async () => {
    const smtp = smtpConfig();

    await deliver(smtpRoute(smtp));
    await deliver(smtpRoute(smtp));

    expect(orgTransporters).toHaveLength(1);
    expect(resolveSmtpHostAddress).toHaveBeenCalledTimes(1);
    expect(orgSendMail).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the transporter and closes the old one when the settings version changes", async () => {
    const smtp = smtpConfig();

    await deliver(smtpRoute(smtp));
    await deliver(smtpRoute({ ...smtp, version: "2026-02-01T00:00:00.000Z", host: "smtp2.acme.com" }));

    expect(orgTransporters).toHaveLength(2);
    expect(orgTransporters[0].close).toHaveBeenCalledTimes(1);
    expect(orgTransporters[1].close).not.toHaveBeenCalled();
    expect(resolveSmtpHostAddress).toHaveBeenLastCalledWith("smtp2.acme.com", { allowPrivate: false });
  });

  it("rebuilds the transporter and re-checks the host after the TTL expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    const smtp = smtpConfig();

    await deliver(smtpRoute(smtp));
    vi.setSystemTime(new Date("2026-03-01T00:11:00.000Z"));
    await deliver(smtpRoute(smtp));

    expect(orgTransporters).toHaveLength(2);
    expect(orgTransporters[0].close).toHaveBeenCalledTimes(1);
    expect(resolveSmtpHostAddress).toHaveBeenCalledTimes(2);
  });

  it("uses the default transport unchanged when the route has no SMTP", async () => {
    await deliver({ from: "Acme <hello@acme.com>", customized: true, smtp: null });

    expect(resolveSmtpHostAddress).not.toHaveBeenCalled();
    expect(orgTransporters).toHaveLength(0);
    expect(sentFroms()).toEqual(["Acme <hello@acme.com>"]);
  });

  it("never logs the SMTP password", async () => {
    orgSendMail.mockImplementation((_payload, callback) =>
      callback(Object.assign(new Error(`535 auth failed for ${PASSWORD}`), { code: "EAUTH" }))
    );
    sendMail.mockImplementation((_payload, callback) => callback(new Error("smtp down")));

    await deliver(smtpRoute(smtpConfig())).catch(() => undefined);
    resolveSmtpHostAddress.mockResolvedValue({ ok: false, error: "organization_smtp_host_blocked" });
    await deliver(smtpRoute(smtpConfig())).catch(() => undefined);

    expect(console.warn).toHaveBeenCalled();
    expect(allConsoleOutput()).not.toContain(PASSWORD);
  });
});
