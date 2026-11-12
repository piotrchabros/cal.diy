import type { SmtpTransportOptions } from "@calcom/lib/smtp/buildSmtpTransportOptions";

export type SmtpTestMessage = { from: string; to: string; subject: string; text: string };

export interface ISmtpConnectionTester {
  verify(options: SmtpTransportOptions, timeoutMs: number): Promise<void>;
  sendTestMessage(options: SmtpTransportOptions, message: SmtpTestMessage, timeoutMs: number): Promise<void>;
}

export class NodemailerSmtpConnectionTester implements ISmtpConnectionTester {
  async verify(options: SmtpTransportOptions, timeoutMs: number): Promise<void> {
    await this.run(options, timeoutMs, (transport) => transport.verify());
  }

  async sendTestMessage(
    options: SmtpTransportOptions,
    message: SmtpTestMessage,
    timeoutMs: number
  ): Promise<void> {
    await this.run(options, timeoutMs, (transport) => transport.sendMail(message));
  }

  private async run(
    options: SmtpTransportOptions,
    timeoutMs: number,
    action: (transport: import("nodemailer").Transporter) => Promise<unknown>
  ): Promise<void> {
    // Loaded lazily so the nodemailer dependency stays out of bundles that never test a connection
    const { createTransport } = await import("nodemailer");
    const transport = createTransport(options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        action(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error("SMTP test timed out"), { code: "ETIMEDOUT" })),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      transport.close();
    }
  }
}
