import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { deliverOrganizationMail, resolveOrganizationMailRoute } from "@calcom/emails/lib/organizationMailer";
import { parseFromHeader } from "@calcom/emails/lib/organizationSender";
import { getOrganizationOriginForUrl } from "@calcom/features/organizations/lib/getOrganizationOrigin";
import { APP_NAME, EMAIL_FROM_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import { serverConfig } from "@calcom/lib/serverConfig";
import Handlebars from "handlebars";
import type { SendVerificationRequestParams } from "next-auth/providers/email";

const LOG_NAME = "MAGIC_LINK_EMAIL";

const sendVerificationRequest = async ({
  identifier,
  url,
}: Pick<SendVerificationRequestParams, "identifier" | "url">) => {
  const emailsDir = path.resolve(process.cwd(), "..", "..", "packages/emails", "templates");
  const originalUrl = new URL(url);
  const webappUrl = new URL(process.env.NEXTAUTH_URL || WEBAPP_URL);
  // A link already on an organization's own domain is kept so the session cookie lands on that domain.
  if (
    originalUrl.origin !== webappUrl.origin &&
    originalUrl.origin !== (await getOrganizationOriginForUrl(url))
  ) {
    url = url.replace(originalUrl.origin, webappUrl.origin);
  }
  const emailFile = readFileSync(path.join(emailsDir, "confirm-email.html"), {
    encoding: "utf8",
  });
  const emailTemplate = Handlebars.compile(emailFile);
  const originalFrom = `${EMAIL_FROM_NAME} <${parseFromHeader(serverConfig.from ?? "").address}>`;
  const route = await resolveOrganizationMailRoute({
    from: originalFrom,
    envFrom: serverConfig.from,
    scope: { userEmail: identifier },
    logName: LOG_NAME,
  });
  // Not awaited so the sign-in response isn't held up by SMTP latency.
  deliverOrganizationMail({
    payload: {
      to: identifier,
      subject: `Your sign-in link for ${APP_NAME}`,
      html: emailTemplate({
        base_url: WEBAPP_URL,
        signin_url: url,
        email: identifier,
      }),
    },
    route,
    originalFrom,
    defaultTransport: serverConfig.transport,
    logName: LOG_NAME,
  }).catch((error) => console.error(`${LOG_NAME}: failed to send sign-in link`, error));
};

export default sendVerificationRequest;
