import { EMAIL_FROM_NAME } from "@calcom/lib/constants";
import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import type {
  OrganizationSmtpSecurity,
  OrganizationSmtpSettingsDto,
} from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { buildSmtpTransportOptions } from "@calcom/lib/smtp/buildSmtpTransportOptions";
import {
  isSmtpPortAllowed,
  parseSmtpHost,
  resolveSmtpHostAddress,
  SMTP_HOST_ERRORS,
} from "@calcom/lib/smtp/smtpHostPolicy";
import { ORGANIZATION_ERRORS } from "../lib/organizationErrors";
import type { ISmtpConnectionTester } from "../lib/SmtpConnectionTester";
import type { IOrganizationSmtpSettingsRepository } from "../repositories/interfaces/IOrganizationSmtpSettingsRepository";
import type { OrganizationEmailSenderService } from "./OrganizationEmailSenderService";
import type { OrganizationMembershipService } from "./OrganizationMembershipService";

const log = logger.getSubLogger({ prefix: ["[OrganizationSmtpSettingsService]"] });

const MAX_USERNAME_LENGTH = 320;
const TEST_TIMEOUT_MS = 15_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const ORGANIZATION_SMTP_ERRORS = {
  usernameInvalid: "organization_smtp_username_invalid",
  passwordRequired: "organization_smtp_password_required",
  notConfigured: "organization_smtp_not_configured",
  noSenderAddress: "organization_smtp_no_sender_address",
  testFailedAuth: "organization_smtp_test_failed_auth",
  testFailedRejected: "organization_smtp_test_failed_rejected",
  testFailedConnection: "organization_smtp_test_failed_connection",
  testFailedTimeout: "organization_smtp_test_failed_timeout",
  testFailedTls: "organization_smtp_test_failed_tls",
  testFailedUnknown: "organization_smtp_test_failed_unknown",
} as const;

export type OrganizationSmtpConfig = {
  encryptionKey: string;
  allowPrivateHosts: boolean;
};

export interface IOrganizationSmtpSettingsServiceDeps {
  smtpSettingsRepository: IOrganizationSmtpSettingsRepository;
  organizationMembershipService: Pick<OrganizationMembershipService, "getRole">;
  emailSenderService: Pick<
    OrganizationEmailSenderService,
    "invalidateOrganization" | "resolveDeliveryForScope"
  >;
  connectionTester: ISmtpConnectionTester;
  smtpConfig: OrganizationSmtpConfig;
}

function parseUsername(raw: string | null): string | null {
  if (raw === null) return null;
  const username = raw.trim();
  if (username === "") return null;
  if (username.length > MAX_USERNAME_LENGTH || CONTROL_CHARS.test(username)) {
    throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_SMTP_ERRORS.usernameInvalid);
  }
  return username;
}

function toTestErrorKey(error: unknown): string {
  const { code, responseCode, message } = (error ?? {}) as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
  };
  if (code === "EAUTH") return ORGANIZATION_SMTP_ERRORS.testFailedAuth;
  if (code === "EENVELOPE" || responseCode === 550 || responseCode === 553 || responseCode === 554) {
    return ORGANIZATION_SMTP_ERRORS.testFailedRejected;
  }
  if (code === "ETIMEDOUT" || (typeof message === "string" && /timed? ?out/i.test(message))) {
    return ORGANIZATION_SMTP_ERRORS.testFailedTimeout;
  }
  if (code === "ECONNECTION" || code === "ECONNREFUSED" || code === "EDNS") {
    return ORGANIZATION_SMTP_ERRORS.testFailedConnection;
  }
  if (
    code === "ESOCKET" ||
    (typeof code === "string" && code.startsWith("ERR_TLS")) ||
    (typeof message === "string" && /\b(tls|ssl|certificate)\b/i.test(message))
  ) {
    return ORGANIZATION_SMTP_ERRORS.testFailedTls;
  }
  return ORGANIZATION_SMTP_ERRORS.testFailedUnknown;
}

export class OrganizationSmtpSettingsService {
  constructor(private readonly deps: IOrganizationSmtpSettingsServiceDeps) {}

  async get(params: { organizationId: number; viewerUserId: number }): Promise<OrganizationSmtpSettingsDto> {
    const { organizationId, viewerUserId } = params;
    const role = await this.deps.organizationMembershipService.getRole(viewerUserId, organizationId);
    if (role === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    const record = await this.deps.smtpSettingsRepository.findByOrganizationId(organizationId);
    const canEdit = role !== "MEMBER";
    if (!record) {
      return {
        configured: false,
        host: null,
        port: null,
        security: null,
        username: null,
        hasPassword: false,
        lastVerifiedAt: null,
        canEdit,
      };
    }

    return {
      configured: true,
      host: record.host,
      port: record.port,
      security: record.security,
      username: record.username,
      hasPassword: record.passwordEncrypted !== null,
      lastVerifiedAt: record.lastVerifiedAt?.toISOString() ?? null,
      canEdit,
    };
  }

  async update(params: {
    organizationId: number;
    actorUserId: number;
    host: string;
    port: number;
    security: OrganizationSmtpSecurity;
    username: string | null;
    password?: string;
  }): Promise<void> {
    const { organizationId, actorUserId, port, security } = params;
    await this.assertManager(organizationId, actorUserId);

    const host = parseSmtpHost(params.host);
    if (!host) throw ErrorWithCode.Factory.BadRequest(SMTP_HOST_ERRORS.invalidHost);
    if (!isSmtpPortAllowed(port)) throw ErrorWithCode.Factory.BadRequest(SMTP_HOST_ERRORS.portNotAllowed);

    const resolution = await resolveSmtpHostAddress(host, {
      allowPrivate: this.deps.smtpConfig.allowPrivateHosts,
    });
    if (!resolution.ok) throw ErrorWithCode.Factory.BadRequest(resolution.error);

    const username = parseUsername(params.username);
    const passwordEncrypted = await this.resolvePasswordCiphertext(organizationId, username, params.password);

    await this.deps.smtpSettingsRepository.upsert(organizationId, {
      host,
      port,
      security,
      username,
      passwordEncrypted,
    });
    this.deps.emailSenderService.invalidateOrganization(organizationId);
    log.info("organization.smtp.update", {
      action: "organization.smtp.update",
      actorUserId,
      organizationId,
      host,
    });
  }

  async remove(params: { organizationId: number; actorUserId: number }): Promise<void> {
    const { organizationId, actorUserId } = params;
    await this.assertManager(organizationId, actorUserId);

    await this.deps.smtpSettingsRepository.delete(organizationId);
    this.deps.emailSenderService.invalidateOrganization(organizationId);
    log.info("organization.smtp.remove", {
      action: "organization.smtp.remove",
      actorUserId,
      organizationId,
    });
  }

  async test(params: { organizationId: number; actorUserId: number; sendTo: string | null }): Promise<void> {
    const { organizationId, actorUserId, sendTo } = params;
    await this.assertManager(organizationId, actorUserId);

    const record = await this.deps.smtpSettingsRepository.findByOrganizationId(organizationId);
    if (!record) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_SMTP_ERRORS.notConfigured);

    let from: string | null = null;
    if (sendTo !== null) {
      const delivery = await this.deps.emailSenderService.resolveDeliveryForScope({ organizationId });
      // Without an address of its own the organization's mail would fall back to the default
      // transport, so there is nothing meaningful to test sending through this server
      if (!delivery?.smtp || !delivery.sender?.address) {
        throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_SMTP_ERRORS.noSenderAddress);
      }
      from = `${delivery.sender.name ?? EMAIL_FROM_NAME} <${delivery.sender.address}>`;
    }

    let password: string | null = null;
    if (record.passwordEncrypted !== null) {
      try {
        password = symmetricDecrypt(record.passwordEncrypted, this.deps.smtpConfig.encryptionKey);
      } catch {
        log.warn("organization.smtp.decrypt_failed", { organizationId });
        throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_SMTP_ERRORS.testFailedUnknown);
      }
    }

    const resolution = await resolveSmtpHostAddress(record.host, {
      allowPrivate: this.deps.smtpConfig.allowPrivateHosts,
    });
    if (!resolution.ok) throw ErrorWithCode.Factory.BadRequest(resolution.error);

    const options = buildSmtpTransportOptions({ ...record, password }, resolution.address);

    try {
      await this.deps.connectionTester.verify(options, TEST_TIMEOUT_MS);
      if (from !== null && sendTo !== null) {
        await this.deps.connectionTester.sendTestMessage(
          options,
          {
            from,
            to: sendTo,
            subject: "SMTP test message",
            text: "This is a test message confirming your organization's SMTP settings work.",
          },
          TEST_TIMEOUT_MS
        );
      }
    } catch (error) {
      const key = toTestErrorKey(error);
      // Only the error code is logged: server responses can echo credentials or internal hosts
      log.warn("organization.smtp.test_failed", {
        action: "organization.smtp.test_failed",
        actorUserId,
        organizationId,
        host: record.host,
        result: key,
      });
      throw ErrorWithCode.Factory.BadRequest(key);
    }

    await this.deps.smtpSettingsRepository.markVerified(organizationId, new Date());
    log.info("organization.smtp.test", {
      action: "organization.smtp.test",
      actorUserId,
      organizationId,
      host: record.host,
    });
  }

  private async assertManager(organizationId: number, userId: number): Promise<void> {
    const role = await this.deps.organizationMembershipService.getRole(userId, organizationId);
    if (role === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);
    if (role === "MEMBER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyManagersCanUpdateOrganization);
    }
  }

  private async resolvePasswordCiphertext(
    organizationId: number,
    username: string | null,
    password: string | undefined
  ): Promise<string | null> {
    if (username === null) return null;
    if (password) return symmetricEncrypt(password, this.deps.smtpConfig.encryptionKey);

    const existing = await this.deps.smtpSettingsRepository.findByOrganizationId(organizationId);
    if (existing?.passwordEncrypted == null) {
      throw ErrorWithCode.Factory.BadRequest(ORGANIZATION_SMTP_ERRORS.passwordRequired);
    }
    return existing.passwordEncrypted;
  }
}
