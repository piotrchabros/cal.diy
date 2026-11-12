import process from "node:process";
import dayjs from "@calcom/dayjs";
import { FeaturesRepository } from "@calcom/features/flags/features.repository";
import type { EmailSenderScope } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import isSmsCalEmail from "@calcom/lib/isSmsCalEmail";
import { serverConfig } from "@calcom/lib/serverConfig";
import { setTestEmail } from "@calcom/lib/testEmails";
import { prisma } from "@calcom/prisma";
import { decodeHTML } from "entities";
import { z } from "zod";
import { deliverOrganizationMail, resolveOrganizationMailRoute } from "../lib/organizationMailer";
import { sanitizeDisplayName } from "../lib/sanitizeDisplayName";

export default class BaseEmail {
  name = "";

  protected getTimezone() {
    return "";
  }

  protected getLocale(): string {
    return "";
  }

  protected getFormattedRecipientTime({ time, format }: { time: string; format: string }) {
    return dayjs(time).tz(this.getTimezone()).locale(this.getLocale()).format(format);
  }

  protected async getNodeMailerPayload(): Promise<Record<string, unknown>> {
    return {};
  }

  protected getSenderScope(): EmailSenderScope | null {
    return null;
  }

  public async sendEmail() {
    const featuresRepository = new FeaturesRepository(prisma);
    const emailsDisabled = await featuresRepository.checkIfFeatureIsEnabledGlobally("emails");
    /** If email kill switch exists and is active, we prevent emails being sent. */
    if (emailsDisabled) {
      console.warn("Skipped Sending Email due to active Kill Switch");
      return new Promise((r) => r("Skipped Sending Email due to active Kill Switch"));
    }

    const payload = await this.getNodeMailerPayload();
    const originalFrom = typeof payload.from === "string" ? payload.from : "";
    const route = await resolveOrganizationMailRoute({
      from: originalFrom,
      envFrom: this.getMailerOptions().from,
      scope: typeof payload.from === "string" ? this.getSenderScope() : null,
      logName: this.name,
    });

    if (process.env.INTEGRATION_TEST_MODE === "true") {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-expect-error
      setTestEmail({ ...payload, from: route.from });
      console.log(
        "Skipped Sending Email as process.env.NEXT_PUBLIC_UNIT_TESTS is set. Emails are available in globalThis.testEmails"
      );
      return new Promise((r) => r("Skipped sendEmail for Unit Tests"));
    }

    const to = "to" in payload ? (payload.to as string) : "";

    if (isSmsCalEmail(to)) {
      console.log(`Skipped Sending Email to faux email: ${to}`);
      return new Promise((r) => r(`Skipped Sending Email to faux email: ${to}`));
    }

    const parseSubject = z.string().safeParse(payload?.subject);
    const payloadWithUnEscapedSubject = {
      headers: this.getMailerOptions().headers,
      ...payload,
      ...{
        from: sanitizeDisplayName(route.from),
        to: sanitizeDisplayName(to),
      },
      ...(parseSubject.success && { subject: decodeHTML(parseSubject.data) }),
    };
    await deliverOrganizationMail({
      payload: payloadWithUnEscapedSubject,
      route,
      originalFrom,
      defaultTransport: this.getMailerOptions().transport,
      logName: this.name,
      onTransportError: (error) => this.printNodeMailerError(error),
    }).catch((e) => this.logSendError(payloadWithUnEscapedSubject, e));
    return new Promise((resolve) => resolve("send mail async"));
  }
  private logSendError(payload: Record<string, unknown>, error: unknown) {
    console.error(
      "sendEmail",
      `from: ${"from" in payload ? payload.from : ""}`,
      `subject: ${"subject" in payload ? payload.subject : ""}`,
      error
    );
  }
  protected getMailerOptions() {
    return {
      transport: serverConfig.transport,
      from: serverConfig.from,
      headers: serverConfig.headers,
    };
  }
  protected printNodeMailerError(error: Error): void {
    /** Don't clog the logs with unsent emails in E2E */
    if (process.env.NEXT_PUBLIC_IS_E2E) return;
    console.error(`${this.name}_ERROR`, error);
  }
}
