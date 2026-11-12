import { APP_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type { EmailSenderScope } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import { getServerErrorFromUnknown } from "@calcom/lib/server/getServerErrorFromUnknown";
import type { serverConfig } from "@calcom/lib/serverConfig";
import { applyOrganizationSender, parseFromHeader } from "./organizationSender";
import { sanitizeDisplayName } from "./sanitizeDisplayName";

type MailTransport = (typeof serverConfig)["transport"];

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

export type OrganizationMailRoute = {
  from: string;
  customized: boolean;
  smtp: null;
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
    const sender = await getOrganizationEmailSenderService().resolveForScope(scope);
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
