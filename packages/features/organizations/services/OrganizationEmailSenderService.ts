import { symmetricDecrypt } from "@calcom/lib/crypto";
import type {
  EmailSenderScope,
  OrganizationEmailDeliveryDto,
  OrganizationEmailSenderDto,
  OrganizationEmailSenderSettingsDto,
} from "@calcom/lib/dto/OrganizationEmailSenderDto";
import type { OrganizationSmtpTransportConfig } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import {
  EMAIL_SENDER_ERRORS,
  isSenderDomainAllowed,
  parseSenderAddress,
  parseSenderName,
  toSenderAddressOrNull,
} from "../lib/emailSenderPolicy";
import { ORGANIZATION_ERRORS } from "../lib/organizationErrors";
import type {
  IOrganizationEmailSenderRepository,
  OrganizationEmailSenderRecord,
  OrganizationSmtpRecord,
} from "../repositories/interfaces/IOrganizationEmailSenderRepository";
import type { OrganizationMembershipService } from "./OrganizationMembershipService";

const log = logger.getSubLogger({ prefix: ["[OrganizationEmailSenderService]"] });

const CACHE_TTL_MS = 60_000;

export type OrganizationEmailSenderConfig = {
  defaultName: string;
  defaultAddress: string | null;
  encryptionKey: string;
};

export interface IOrganizationEmailSenderServiceDeps {
  emailSenderRepository: IOrganizationEmailSenderRepository;
  organizationMembershipService: Pick<OrganizationMembershipService, "getRole">;
  emailSenderConfig: OrganizationEmailSenderConfig;
}

type CacheEntry = {
  expiresAt: number;
  organizationId: number | null;
  value: OrganizationEmailDeliveryDto | null;
};

export class OrganizationEmailSenderService {
  // Emails are sent in bursts per organization; the cache spares a lookup for each message
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: IOrganizationEmailSenderServiceDeps) {}

  async get(params: {
    organizationId: number;
    viewerUserId: number;
  }): Promise<OrganizationEmailSenderSettingsDto> {
    const { organizationId, viewerUserId } = params;
    const role = await this.deps.organizationMembershipService.getRole(viewerUserId, organizationId);
    if (role === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    const record = await this.deps.emailSenderRepository.findByOrganizationId(organizationId);
    const customDomain = record?.customDomain ?? null;
    const senderAddress = record?.emailFromAddress ?? null;

    return {
      senderName: record?.emailFromName ?? null,
      senderAddress,
      senderAddressActive: senderAddress !== null && isSenderDomainAllowed(senderAddress, customDomain),
      allowedDomain: getAllowedDomain(customDomain),
      fallbackSenderName: this.deps.emailSenderConfig.defaultName,
      fallbackSenderAddress: this.deps.emailSenderConfig.defaultAddress,
      canEdit: role !== "MEMBER",
      usesOrganizationSmtp: record?.smtp != null,
    };
  }

  async update(params: {
    organizationId: number;
    actorUserId: number;
    senderName?: string | null;
    senderAddress?: string | null;
  }): Promise<void> {
    const { organizationId, actorUserId } = params;
    const role = await this.deps.organizationMembershipService.getRole(actorUserId, organizationId);
    if (role === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);
    if (role === "MEMBER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyManagersCanUpdateOrganization);
    }

    const record = await this.deps.emailSenderRepository.findByOrganizationId(organizationId);
    if (!record) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    const emailFromName =
      params.senderName === undefined ? record.emailFromName : parseSenderName(params.senderName);
    const emailFromAddress =
      params.senderAddress === undefined ? record.emailFromAddress : parseSenderAddress(params.senderAddress);

    if (params.senderAddress !== undefined && emailFromAddress !== null) {
      if (record.customDomain === null) {
        throw ErrorWithCode.Factory.BadRequest(EMAIL_SENDER_ERRORS.noDomain);
      }
      if (!isSenderDomainAllowed(emailFromAddress, record.customDomain)) {
        throw ErrorWithCode.Factory.BadRequest(EMAIL_SENDER_ERRORS.domainNotAllowed);
      }
    }

    await this.deps.emailSenderRepository.update(organizationId, { emailFromName, emailFromAddress });
    this.invalidateOrganization(organizationId);
    log.info("organization.email_sender.update", {
      action: "organization.email_sender.update",
      actorUserId,
      organizationId,
    });
  }

  async resolveForScope(scope: EmailSenderScope): Promise<OrganizationEmailSenderDto | null> {
    return (await this.resolveDeliveryForScope(scope))?.sender ?? null;
  }

  async resolveDeliveryForScope(scope: EmailSenderScope): Promise<OrganizationEmailDeliveryDto | null> {
    const key = JSON.stringify(scope);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const organizationId = await this.resolveOrganizationId(scope);
    const record =
      organizationId === null
        ? null
        : await this.deps.emailSenderRepository.findByOrganizationId(organizationId);
    const value = record ? this.toDelivery(record) : null;

    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, organizationId, value });
    return value;
  }

  invalidateOrganization(organizationId: number): void {
    this.cache.forEach((entry, key) => {
      if (entry.organizationId === organizationId) this.cache.delete(key);
    });
  }

  private toDelivery(record: OrganizationEmailSenderRecord): OrganizationEmailDeliveryDto | null {
    const allowedAddress = getAllowedSenderAddress(record);
    // The env sender address must never go out through an organization's own SMTP server, so SMTP is
    // only used when the organization has an address of its own to send from
    const smtpFromAddress = record.smtp
      ? (allowedAddress ?? toSenderAddressOrNull(record.smtp.username))
      : null;
    const smtp =
      record.smtp && smtpFromAddress !== null
        ? this.toSmtpTransport(record.organizationId, record.smtp)
        : null;
    const address = smtp ? smtpFromAddress : allowedAddress;
    const sender =
      record.emailFromName === null && address === null ? null : { name: record.emailFromName, address };
    if (sender === null && smtp === null) return null;
    return { sender, smtp };
  }

  private toSmtpTransport(
    organizationId: number,
    smtp: OrganizationSmtpRecord
  ): OrganizationSmtpTransportConfig | null {
    let password: string | null = null;
    if (smtp.passwordEncrypted !== null) {
      try {
        password = symmetricDecrypt(smtp.passwordEncrypted, this.deps.emailSenderConfig.encryptionKey);
      } catch {
        log.warn("organization.smtp.decrypt_failed", { organizationId });
        return null;
      }
    }
    return {
      organizationId,
      version: smtp.updatedAt.toISOString(),
      host: smtp.host,
      port: smtp.port,
      security: smtp.security,
      username: smtp.username,
      password,
    };
  }

  private resolveOrganizationId(scope: EmailSenderScope): Promise<number | null> {
    const repository = this.deps.emailSenderRepository;
    if ("organizationId" in scope) return Promise.resolve(scope.organizationId);
    if ("teamId" in scope) return repository.findOrganizationIdByTeamId(scope.teamId);
    if ("userId" in scope) return repository.findOrganizationIdByUserId(scope.userId);
    if ("eventTypeId" in scope) return repository.findOrganizationIdByEventTypeId(scope.eventTypeId);
    return repository.findOrganizationIdByUserEmail(scope.userEmail);
  }
}

// The domain may have changed since the address was saved, so it is re-checked on every send
function getAllowedSenderAddress(record: OrganizationEmailSenderRecord): string | null {
  return record.emailFromAddress !== null &&
    isSenderDomainAllowed(record.emailFromAddress, record.customDomain)
    ? record.emailFromAddress
    : null;
}

function getAllowedDomain(customDomain: string | null): string | null {
  if (customDomain === null) return null;
  const labels = customDomain.split(".");
  return labels.length >= 3 ? labels.slice(1).join(".") : customDomain;
}
