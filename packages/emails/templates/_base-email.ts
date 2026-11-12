import process from "node:process";
import dayjs from "@calcom/dayjs";
import { FeaturesRepository } from "@calcom/features/flags/features.repository";
import { APP_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type { EmailSenderScope } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import isSmsCalEmail from "@calcom/lib/isSmsCalEmail";
import { getServerErrorFromUnknown } from "@calcom/lib/server/getServerErrorFromUnknown";
import { serverConfig } from "@calcom/lib/serverConfig";
import { setTestEmail } from "@calcom/lib/testEmails";
import { prisma } from "@calcom/prisma";
import { decodeHTML } from "entities";
import { z } from "zod";
import { applyOrganizationSender, parseFromHeader } from "../lib/organizationSender";
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

  private async applySender(payload: Record<string, unknown>): Promise<{
    payload: Record<string, unknown>;
    customized: boolean;
  }> {
    const scope = this.getSenderScope();
    if (!scope || typeof payload.from !== "string") return { payload, customized: false };

    const envFrom = this.getMailerOptions().from;
    if (!envFrom) return { payload, customized: false };

    try {
      const { getOrganizationEmailSenderService } = await import(
        "@calcom/features/organizations/di/OrganizationEmailSenderService.container"
      );
      const sender = await getOrganizationEmailSenderService().resolveForScope(scope);
      if (!sender) return { payload, customized: false };

      const { from, customized } = applyOrganizationSender(payload.from, sender, {
        address: parseFromHeader(envFrom).address,
        systemNames: [EMAIL_FROM_NAME, APP_NAME],
      });
      return { payload: { ...payload, from }, customized };
    } catch (error) {
      console.warn(`${this.name}: failed to resolve organization email sender, using default`, error);
      return { payload, customized: false };
    }
  }
  public async sendEmail() {
    const featuresRepository = new FeaturesRepository(prisma);
    const emailsDisabled = await featuresRepository.checkIfFeatureIsEnabledGlobally("emails");
    /** If email kill switch exists and is active, we prevent emails being sent. */
    if (emailsDisabled) {
      console.warn("Skipped Sending Email due to active Kill Switch");
      return new Promise((r) => r("Skipped Sending Email due to active Kill Switch"));
    }

    if (process.env.INTEGRATION_TEST_MODE === "true") {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      //@ts-expect-error
      setTestEmail((await this.applySender(await this.getNodeMailerPayload())).payload);
      console.log(
        "Skipped Sending Email as process.env.NEXT_PUBLIC_UNIT_TESTS is set. Emails are available in globalThis.testEmails"
      );
      return new Promise((r) => r("Skipped sendEmail for Unit Tests"));
    }

    const originalPayload = await this.getNodeMailerPayload();
    const { payload, customized } = await this.applySender(originalPayload);

    const from = "from" in payload ? (payload.from as string) : "";
    const to = "to" in payload ? (payload.to as string) : "";

    if (isSmsCalEmail(to)) {
      console.log(`Skipped Sending Email to faux email: ${to}`);
      return new Promise((r) => r(`Skipped Sending Email to faux email: ${to}`));
    }

    const sanitizedFrom = sanitizeDisplayName(from);
    const sanitizedTo = sanitizeDisplayName(to);

    const parseSubject = z.string().safeParse(payload?.subject);
    const payloadWithUnEscapedSubject = {
      headers: this.getMailerOptions().headers,
      ...payload,
      ...{
        from: sanitizedFrom,
        to: sanitizedTo,
      },
      ...(parseSubject.success && { subject: decodeHTML(parseSubject.data) }),
    };
    try {
      await this.deliver(payloadWithUnEscapedSubject);
    } catch (e) {
      if (customized) {
        // An organization's sender domain may not be verified with the provider yet; fall back to the env sender.
        console.warn(
          `${this.name}: delivery with organization sender failed, retrying with default sender`,
          e
        );
        const originalFrom = "from" in originalPayload ? (originalPayload.from as string) : "";
        await this.deliver({ ...payloadWithUnEscapedSubject, from: sanitizeDisplayName(originalFrom) }).catch(
          (retryError) => this.logSendError(payloadWithUnEscapedSubject, retryError)
        );
      } else {
        this.logSendError(payloadWithUnEscapedSubject, e);
      }
    }
    return new Promise((resolve) => resolve("send mail async"));
  }
  private async deliver(payload: Record<string, unknown>) {
    const { createTransport } = await import("nodemailer");
    return new Promise((resolve, reject) =>
      createTransport(this.getMailerOptions().transport).sendMail(payload, (_err, info) => {
        if (_err) {
          const err = getServerErrorFromUnknown(_err);
          this.printNodeMailerError(err);
          reject(err);
        } else {
          resolve(info);
        }
      })
    );
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
