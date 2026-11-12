import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import type { OrganizationEmailDeliveryDto } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORGANIZATION_ERRORS } from "../lib/organizationErrors";
import type { ISmtpConnectionTester } from "../lib/SmtpConnectionTester";
import type {
  IOrganizationSmtpSettingsRepository,
  OrganizationSmtpSettingsRecord,
} from "../repositories/interfaces/IOrganizationSmtpSettingsRepository";
import { OrganizationSmtpSettingsService } from "./OrganizationSmtpSettingsService";

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));

vi.mock("@calcom/lib/smtp/smtpHostPolicy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/lib/smtp/smtpHostPolicy")>();
  return { ...actual, resolveSmtpHostAddress: resolveMock };
});

const ORG_ID = 7;
const ACTOR_ID = 1;
const KEY = "0123456789abcdef0123456789abcdef";

const makeRecord = (
  overrides: Partial<OrganizationSmtpSettingsRecord> = {}
): OrganizationSmtpSettingsRecord => ({
  organizationId: ORG_ID,
  host: "smtp.jellymatch.tech",
  port: 587,
  security: "STARTTLS",
  username: "mailer@jellymatch.tech",
  passwordEncrypted: symmetricEncrypt("s3cret", KEY),
  lastVerifiedAt: null,
  updatedAt: new Date("2026-11-01T10:00:00.000Z"),
  ...overrides,
});

const makeDelivery = (hasSmtp = true, address: string | null = "hello@jellymatch.tech") =>
  ({
    sender: { name: "Jelly", address },
    smtp: hasSmtp
      ? {
          organizationId: ORG_ID,
          version: "v",
          host: "h",
          port: 587,
          security: "STARTTLS",
          username: "u",
          password: "p",
        }
      : null,
  }) as OrganizationEmailDeliveryDto;

function setup(
  options: {
    role?: OrganizationRoleDto | null;
    record?: OrganizationSmtpSettingsRecord | null;
    delivery?: OrganizationEmailDeliveryDto | null;
    allowPrivateHosts?: boolean;
  } = {}
) {
  const record = options.record === undefined ? makeRecord() : options.record;
  const repository = {
    findByOrganizationId: vi.fn().mockResolvedValue(record),
    upsert: vi.fn().mockResolvedValue(record),
    delete: vi.fn().mockResolvedValue(undefined),
    markVerified: vi.fn().mockResolvedValue(undefined),
  } satisfies IOrganizationSmtpSettingsRepository;
  const connectionTester = {
    verify: vi.fn().mockResolvedValue(undefined),
    sendTestMessage: vi.fn().mockResolvedValue(undefined),
  } satisfies ISmtpConnectionTester;
  const emailSenderService = {
    invalidateOrganization: vi.fn(),
    resolveDeliveryForScope: vi
      .fn()
      .mockResolvedValue(options.delivery === undefined ? makeDelivery() : options.delivery),
  };
  const service = new OrganizationSmtpSettingsService({
    smtpSettingsRepository: repository,
    organizationMembershipService: {
      getRole: vi.fn().mockResolvedValue(options.role === undefined ? "ADMIN" : options.role),
    },
    emailSenderService,
    connectionTester,
    smtpConfig: { encryptionKey: KEY, allowPrivateHosts: options.allowPrivateHosts ?? false },
  });
  return { service, repository, connectionTester, emailSenderService };
}

const validUpdate = {
  organizationId: ORG_ID,
  actorUserId: ACTOR_ID,
  host: "SMTP.Jellymatch.tech",
  port: 587,
  security: "STARTTLS" as const,
  username: "mailer@jellymatch.tech",
  password: "newpass",
};

beforeEach(() => {
  resolveMock.mockReset();
  resolveMock.mockResolvedValue({ ok: true, address: "203.0.113.5" });
});

describe("get", () => {
  it("rejects non-members", async () => {
    const { service } = setup({ role: null });
    await expect(service.get({ organizationId: ORG_ID, viewerUserId: 2 })).rejects.toMatchObject({
      message: ORGANIZATION_ERRORS.notFound,
    });
  });

  it("lets a member read but not edit, and never exposes the password", async () => {
    const { service } = setup({ role: "MEMBER" });
    const dto = await service.get({ organizationId: ORG_ID, viewerUserId: 2 });
    expect(dto).toMatchObject({ configured: true, hasPassword: true, canEdit: false });
    expect(JSON.stringify(dto)).not.toContain("s3cret");
    expect(JSON.stringify(dto)).not.toContain("passwordEncrypted");
  });

  it("returns an unconfigured dto when there is no row", async () => {
    const { service } = setup({ record: null, role: "OWNER" });
    expect(await service.get({ organizationId: ORG_ID, viewerUserId: 2 })).toEqual({
      configured: false,
      host: null,
      port: null,
      security: null,
      username: null,
      hasPassword: false,
      lastVerifiedAt: null,
      canEdit: true,
    });
  });
});

describe("update", () => {
  it("rejects non-members and members", async () => {
    await expect(setup({ role: null }).service.update(validUpdate)).rejects.toMatchObject({
      message: ORGANIZATION_ERRORS.notFound,
    });
    await expect(setup({ role: "MEMBER" }).service.update(validUpdate)).rejects.toMatchObject({
      message: ORGANIZATION_ERRORS.onlyManagersCanUpdateOrganization,
    });
  });

  it("encrypts a new password, normalizes the host and invalidates the cache", async () => {
    const { service, repository, emailSenderService } = setup();
    await service.update(validUpdate);
    const data = repository.upsert.mock.calls[0][1];
    expect(data.host).toBe("smtp.jellymatch.tech");
    expect(data.passwordEncrypted).not.toBe("newpass");
    expect(symmetricDecrypt(data.passwordEncrypted, KEY)).toBe("newpass");
    expect(emailSenderService.invalidateOrganization).toHaveBeenCalledWith(ORG_ID);
  });

  it("keeps the stored ciphertext when the password is empty or omitted", async () => {
    const record = makeRecord();
    const { service, repository } = setup({ record });
    await service.update({ ...validUpdate, password: "" });
    await service.update({ ...validUpdate, password: undefined });
    expect(repository.upsert.mock.calls[0][1].passwordEncrypted).toBe(record.passwordEncrypted);
    expect(repository.upsert.mock.calls[1][1].passwordEncrypted).toBe(record.passwordEncrypted);
  });

  it("requires a password when a username is set and none is stored", async () => {
    const { service, repository } = setup({ record: null });
    await expect(service.update({ ...validUpdate, password: undefined })).rejects.toMatchObject({
      message: "organization_smtp_password_required",
    });
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("clears username and password when username is empty", async () => {
    const { service, repository } = setup();
    await service.update({ ...validUpdate, username: "  ", password: "ignored" });
    expect(repository.upsert.mock.calls[0][1]).toMatchObject({ username: null, passwordEncrypted: null });
  });

  it("rejects invalid usernames", async () => {
    const { service } = setup();
    await expect(service.update({ ...validUpdate, username: "a\nb" })).rejects.toMatchObject({
      message: "organization_smtp_username_invalid",
    });
    await expect(service.update({ ...validUpdate, username: "a".repeat(321) })).rejects.toMatchObject({
      message: "organization_smtp_username_invalid",
    });
  });

  it("rejects invalid hosts and disallowed ports", async () => {
    const { service } = setup();
    await expect(service.update({ ...validUpdate, host: "not a host" })).rejects.toMatchObject({
      message: "organization_smtp_host_invalid",
    });
    await expect(service.update({ ...validUpdate, port: 8080 })).rejects.toMatchObject({
      message: "organization_smtp_port_not_allowed",
    });
  });

  it("rejects private hosts unless allowed", async () => {
    resolveMock.mockResolvedValue({ ok: false, error: "organization_smtp_host_private" });
    const { service, repository } = setup();
    await expect(service.update(validUpdate)).rejects.toMatchObject({
      message: "organization_smtp_host_private",
    });
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it("passes allowPrivate through to host resolution", async () => {
    const { service } = setup({ allowPrivateHosts: true });
    await service.update(validUpdate);
    expect(resolveMock).toHaveBeenCalledWith("smtp.jellymatch.tech", { allowPrivate: true });
  });
});

describe("remove", () => {
  it("deletes and invalidates for managers only", async () => {
    const { service, repository, emailSenderService } = setup({ role: "OWNER" });
    await service.remove({ organizationId: ORG_ID, actorUserId: ACTOR_ID });
    expect(repository.delete).toHaveBeenCalledWith(ORG_ID);
    expect(emailSenderService.invalidateOrganization).toHaveBeenCalledWith(ORG_ID);

    const member = setup({ role: "MEMBER" });
    await expect(
      member.service.remove({ organizationId: ORG_ID, actorUserId: ACTOR_ID })
    ).rejects.toMatchObject({
      message: ORGANIZATION_ERRORS.onlyManagersCanUpdateOrganization,
    });
    expect(member.repository.delete).not.toHaveBeenCalled();
  });
});

describe("test", () => {
  const params = { organizationId: ORG_ID, actorUserId: ACTOR_ID, sendTo: null };

  it("rejects members", async () => {
    await expect(setup({ role: "MEMBER" }).service.test(params)).rejects.toMatchObject({
      message: ORGANIZATION_ERRORS.onlyManagersCanUpdateOrganization,
    });
  });

  it("fails when nothing is saved", async () => {
    await expect(setup({ record: null }).service.test(params)).rejects.toMatchObject({
      message: "organization_smtp_not_configured",
    });
  });

  it("verifies against the pinned address with the decrypted password and marks verified", async () => {
    const { service, connectionTester, repository } = setup();
    await service.test(params);
    const options = connectionTester.verify.mock.calls[0][0];
    expect(options.host).toBe("203.0.113.5");
    expect(options.auth).toEqual({ user: "mailer@jellymatch.tech", pass: "s3cret" });
    expect(connectionTester.sendTestMessage).not.toHaveBeenCalled();
    expect(repository.markVerified).toHaveBeenCalledWith(ORG_ID, expect.any(Date));
  });

  it("sends a test message from the organization sender", async () => {
    const { service, connectionTester, repository } = setup();
    await service.test({ ...params, sendTo: "me@example.com" });
    expect(connectionTester.sendTestMessage.mock.calls[0][1]).toMatchObject({
      from: "Jelly <hello@jellymatch.tech>",
      to: "me@example.com",
    });
    expect(repository.markVerified).toHaveBeenCalled();
  });

  it("refuses to send without an organization sender address, before connecting", async () => {
    for (const delivery of [null, makeDelivery(false), makeDelivery(true, null)]) {
      const { service, connectionTester } = setup({ delivery });
      await expect(service.test({ ...params, sendTo: "me@example.com" })).rejects.toMatchObject({
        message: "organization_smtp_no_sender_address",
      });
      expect(connectionTester.verify).not.toHaveBeenCalled();
    }
  });

  it("rejects hosts that no longer resolve to an allowed address", async () => {
    resolveMock.mockResolvedValue({ ok: false, error: "organization_smtp_host_private" });
    const { service, connectionTester } = setup();
    await expect(service.test(params)).rejects.toMatchObject({ message: "organization_smtp_host_private" });
    expect(connectionTester.verify).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "EAUTH" }, "organization_smtp_test_failed_auth"],
    [{ code: "EENVELOPE" }, "organization_smtp_test_failed_rejected"],
    [{ responseCode: 550 }, "organization_smtp_test_failed_rejected"],
    [{ responseCode: 553 }, "organization_smtp_test_failed_rejected"],
    [{ responseCode: 554 }, "organization_smtp_test_failed_rejected"],
    [{ code: "ECONNECTION" }, "organization_smtp_test_failed_connection"],
    [{ code: "ECONNREFUSED" }, "organization_smtp_test_failed_connection"],
    [{ code: "EDNS" }, "organization_smtp_test_failed_connection"],
    [{ code: "ETIMEDOUT" }, "organization_smtp_test_failed_timeout"],
    [{ message: "Connection timed out" }, "organization_smtp_test_failed_timeout"],
    [{ code: "ESOCKET" }, "organization_smtp_test_failed_tls"],
    [{ message: "self signed certificate" }, "organization_smtp_test_failed_tls"],
    [{ code: "EWHATEVER", message: "secret server response" }, "organization_smtp_test_failed_unknown"],
  ])("maps %j to %s without echoing the server response", async (failure, key) => {
    const { service, repository } = setup();
    const error = Object.assign(new Error((failure as { message?: string }).message ?? "boom"), failure);
    const { connectionTester } = {
      connectionTester: (service as never as { deps: { connectionTester: ISmtpConnectionTester } }).deps
        .connectionTester,
    };
    vi.mocked(connectionTester.verify).mockRejectedValue(error);
    const rejection = await service.test(params).catch((e: Error) => e);
    expect(rejection).toMatchObject({ message: key });
    expect(repository.markVerified).not.toHaveBeenCalled();
  });
});
