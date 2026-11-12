import process from "node:process";
import { APP_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type {
  EmailSenderScope,
  OrganizationEmailSenderDto,
} from "@calcom/lib/dto/OrganizationEmailSenderDto";
import type { OrganizationSmtpTransportConfig } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import { getServerErrorFromUnknown } from "@calcom/lib/server/getServerErrorFromUnknown";
import type { serverConfig } from "@calcom/lib/serverConfig";
import { buildSmtpTransportOptions } from "@calcom/lib/smtp/buildSmtpTransportOptions";
import { resolveSmtpHostAddress } from "@calcom/lib/smtp/smtpHostPolicy";
import type { Transporter } from "nodemailer";
import { applyOrganizationSender, parseFromHeader } from "./organizationSender";
import { sanitizeDisplayName } from "./sanitizeDisplayName";

type MailTransport = (typeof serverConfig)["transport"];

const SMTP_TRANSPORTER_TTL_MS = 10 * 60_000;

type CachedSmtpTransporter = { version: string; expiresAt: number; transporter: Transporter };

// Keyed by organization so a settings change (new version) replaces the old transporter instead of leaking it
const smtpTransporterCache = new Map<number, CachedSmtpTransporter>();

class OrganizationSmtpError extends Error {
  constructor(readonly code: string) {
    super(`Organization SMTP delivery failed: ${code}`);
  }
}

function sendMailWith(transporter: Transporter, payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) =>
    transporter.sendMail(payload, (err, info) => (err ? reject(err) : resolve(info)))
  );
}

async function sendWithTransport(
  transport: MailTransport,
  payload: Record<string, unknown>,
  onTransportError?: (error: Error) => void
): Promise<unknown> {
  const { createTransport } = await import("nodemailer");
  return new Promise((resolve, reject) =>
    createTransport(transport).sendMail(payload, (_err, info) => {
      if (_err) {
        const err = getServerErrorFromUnknown(_err);
        onTransportError?.(err);
        reject(err);
      } else {
        resolve(info);
      }
    })
  );
}

function getSmtpErrorCode(error: unknown): string {
  if (error instanceof OrganizationSmtpError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "UNKNOWN";
}

async function getSmtpTransporter(config: OrganizationSmtpTransportConfig): Promise<Transporter> {
  const cached = smtpTransporterCache.get(config.organizationId);
  if (cached && cached.version === config.version && cached.expiresAt > Date.now()) {
    return cached.transporter;
  }
  if (cached) {
    smtpTransporterCache.delete(config.organizationId);
    cached.transporter.close();
  }

  // The host is re-checked whenever a transporter is built: DNS may now point at a private address.
  const resolution = await resolveSmtpHostAddress(config.host, {
    allowPrivate: process.env.ORGANIZATION_SMTP_ALLOW_PRIVATE_HOSTS === "true",
  });
  if (!resolution.ok) throw new OrganizationSmtpError(resolution.error);

  const { createTransport } = await import("nodemailer");
  // Options without `pool` give a non-pooled SMTP transport: each send opens its own connection to the pinned address.
  const transporter = createTransport(buildSmtpTransportOptions(config, resolution.address));
  smtpTransporterCache.set(config.organizationId, {
    version: config.version,
    expiresAt: Date.now() + SMTP_TRANSPORTER_TTL_MS,
    transporter,
  });
  return transporter;
}

function buildSmtpFrom(from: string, sender: OrganizationEmailSenderDto, address: string): string {
  const { name } = parseFromHeader(from);
  // The address is always the organization's: its SMTP server must never send as the env sender.
  const displayName =
    sender.name && name !== null && [EMAIL_FROM_NAME, APP_NAME].includes(name) ? sender.name : name;
  return displayName ? `${displayName} <${address}>` : address;
}

export type OrganizationMailRoute = {
  from: string;
  customized: boolean;
  smtp: OrganizationSmtpTransportConfig | null;
};

export async function resolveOrganizationMailRoute({
  from,
  envFrom,
  scope,
  logName,
}: {
  from: string;
  envFrom: string | undefined;
  scope: EmailSenderScope | null;
  logName: string;
}): Promise<OrganizationMailRoute> {
  const defaultRoute: OrganizationMailRoute = { from, customized: false, smtp: null };
  if (!scope || !envFrom) return defaultRoute;

  try {
    const { getOrganizationEmailSenderService } = await import(
      "@calcom/features/organizations/di/OrganizationEmailSenderService.container"
    );
    const delivery = await getOrganizationEmailSenderService().resolveDeliveryForScope(scope);
    if (!delivery) return defaultRoute;

    const { sender, smtp } = delivery;
    if (smtp && sender?.address) {
      return { from: buildSmtpFrom(from, sender, sender.address), customized: true, smtp };
    }
    if (!sender) return defaultRoute;

    const applied = applyOrganizationSender(from, sender, {
      address: parseFromHeader(envFrom).address,
      systemNames: [EMAIL_FROM_NAME, APP_NAME],
    });
    return { from: applied.from, customized: applied.customized, smtp: null };
  } catch (error) {
    console.warn(`${logName}: failed to resolve organization email sender, using default`, error);
    return defaultRoute;
  }
}

export async function deliverOrganizationMail({
  payload,
  route,
  originalFrom,
  defaultTransport,
  logName,
  onTransportError,
}: {
  payload: Record<string, unknown>;
  route: OrganizationMailRoute;
  originalFrom: string;
  defaultTransport: MailTransport;
  logName: string;
  onTransportError?: (error: Error) => void;
}): Promise<unknown> {
  if (route.smtp) {
    try {
      const transporter = await getSmtpTransporter(route.smtp);
      return await sendMailWith(transporter, { ...payload, from: sanitizeDisplayName(route.from) });
    } catch (error) {
      // Only the organization and an error code are logged: SMTP errors can echo server responses or auth details.
      console.warn(`${logName}: delivery through organization SMTP failed, retrying with default transport`, {
        organizationId: route.smtp.organizationId,
        code: getSmtpErrorCode(error),
      });
      return sendWithTransport(
        defaultTransport,
        { ...payload, from: sanitizeDisplayName(originalFrom) },
        onTransportError
      );
    }
  }

  try {
    return await sendWithTransport(
      defaultTransport,
      { ...payload, from: sanitizeDisplayName(route.from) },
      onTransportError
    );
  } catch (error) {
    if (!route.customized) throw error;
    // An organization's sender domain may not be verified with the provider yet; fall back to the env sender.
    console.warn(`${logName}: delivery with organization sender failed, retrying with default sender`, error);
    return sendWithTransport(
      defaultTransport,
      { ...payload, from: sanitizeDisplayName(originalFrom) },
      onTransportError
    );
  }
}
