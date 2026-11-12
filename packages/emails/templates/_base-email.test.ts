import process from "node:process";
import { APP_NAME, EMAIL_FROM_NAME } from "@calcom/lib/constants";
import type { EmailSenderScope } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import { getTestEmails, resetTestEmails } from "@calcom/lib/testEmails";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BaseEmail from "./_base-email";

const { sendMail, resolveForScope } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  resolveForScope: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail }),
}));

vi.mock("@calcom/lib/serverConfig", () => ({
  serverConfig: { transport: {}, from: "notifications@cal.example", headers: undefined },
}));

vi.mock("@calcom/prisma", () => ({ prisma: {} }));

vi.mock("@calcom/features/flags/features.repository", () => ({
  FeaturesRepository: class {
    checkIfFeatureIsEnabledGlobally() {
      return Promise.resolve(false);
    }
  },
}));

vi.mock("@calcom/features/organizations/di/OrganizationEmailSenderService.container", () => ({
  getOrganizationEmailSenderService: () => ({
    resolveDeliveryForScope: async (scope: unknown) => {
      const sender = await resolveForScope(scope);
      return sender ? { sender, smtp: null } : null;
    },
  }),
}));

class TestEmail extends BaseEmail {
  constructor(
    private from: string,
    private scope: EmailSenderScope | null
  ) {
    super();
    this.name = "TEST_EMAIL";
  }

  protected async getNodeMailerPayload(): Promise<Record<string, unknown>> {
    return { from: this.from, to: "guest@example.com", subject: "Hello", html: "<p>Hi</p>" };
  }

  protected getSenderScope() {
    return this.scope;
  }
}

const sentFroms = () => sendMail.mock.calls.map(([payload]) => payload.from);

describe("BaseEmail organization sender", () => {
  const integrationTestMode = process.env.INTEGRATION_TEST_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTEGRATION_TEST_MODE = "false";
    sendMail.mockImplementation((_payload, callback) => callback(null, {}));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.INTEGRATION_TEST_MODE = integrationTestMode;
  });

  it("applies the organization sender to captured test emails", async () => {
    process.env.INTEGRATION_TEST_MODE = "true";
    resetTestEmails();
    resolveForScope.mockResolvedValue({ name: "Acme", address: "hello@acme.com" });

    await new TestEmail(`${APP_NAME} <notifications@cal.example>`, { organizationId: 1 }).sendEmail();

    expect(sendMail).not.toHaveBeenCalled();
    expect(getTestEmails().map((email) => email.from)).toEqual(["Acme <hello@acme.com>"]);
  });

  it("keeps the from header when the email has no sender scope", async () => {
    await new TestEmail(`${EMAIL_FROM_NAME} <notifications@cal.example>`, null).sendEmail();

    expect(resolveForScope).not.toHaveBeenCalled();
    expect(sentFroms()).toEqual([`${EMAIL_FROM_NAME} <notifications@cal.example>`]);
  });

  it("keeps the from header when the organization has no sender settings", async () => {
    resolveForScope.mockResolvedValue(null);

    await new TestEmail(`${EMAIL_FROM_NAME} <notifications@cal.example>`, { organizationId: 1 }).sendEmail();

    expect(resolveForScope).toHaveBeenCalledWith({ organizationId: 1 });
    expect(sentFroms()).toEqual([`${EMAIL_FROM_NAME} <notifications@cal.example>`]);
  });

  it("applies the organization name and address to system-named emails", async () => {
    resolveForScope.mockResolvedValue({ name: "Acme", address: "hello@acme.com" });

    await new TestEmail(`${APP_NAME} <notifications@cal.example>`, { organizationId: 1 }).sendEmail();

    expect(sentFroms()).toEqual(["Acme <hello@acme.com>"]);
  });

  it("keeps the organizer name on attendee emails but uses the organization address", async () => {
    resolveForScope.mockResolvedValue({ name: "Acme", address: "hello@acme.com" });

    await new TestEmail("Jane Host <notifications@cal.example>", { userId: 7 }).sendEmail();

    expect(sentFroms()).toEqual(["Jane Host <hello@acme.com>"]);
  });

  it("falls back to the env sender when resolving the organization sender throws", async () => {
    resolveForScope.mockRejectedValue(new Error("db down"));

    await new TestEmail(`${EMAIL_FROM_NAME} <notifications@cal.example>`, { organizationId: 1 }).sendEmail();

    expect(sentFroms()).toEqual([`${EMAIL_FROM_NAME} <notifications@cal.example>`]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("retries once with the original sender when delivery with the organization sender fails", async () => {
    resolveForScope.mockResolvedValue({ name: "Acme", address: "hello@acme.com" });
    sendMail
      .mockImplementationOnce((_payload, callback) => callback(new Error("domain not verified")))
      .mockImplementationOnce((_payload, callback) => callback(null, {}));

    await new TestEmail(`${APP_NAME} <notifications@cal.example>`, { organizationId: 1 }).sendEmail();

    expect(sentFroms()).toEqual(["Acme <hello@acme.com>", `${APP_NAME} <notifications@cal.example>`]);
    expect(console.error).not.toHaveBeenCalledWith(
      "sendEmail",
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it("does not retry a failed delivery when the sender was not customized", async () => {
    sendMail.mockImplementation((_payload, callback) => callback(new Error("smtp down")));

    await new TestEmail(`${EMAIL_FROM_NAME} <notifications@cal.example>`, null).sendEmail();

    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
