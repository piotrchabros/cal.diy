import type { CalendarEvent } from "@calcom/types/Calendar";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import AccountVerifyEmail from "./account-verify-email";
import BookingRedirectNotification from "./booking-redirect-notification";
import BrokenIntegrationEmail from "./broken-integration-email";
import ChangeOfEmailVerifyEmail from "./change-account-email-verify";
import DisabledAppEmail from "./disabled-app-email";
import ForgotPasswordEmail from "./forgot-password-email";

const t = ((key: string) => key) as unknown as TFunction;

const scopeOf = (email: object) => (email as unknown as { getSenderScope(): unknown }).getSenderScope();

describe("account emails sender scope", () => {
  it("scopes account verification to the recipient email by default", () => {
    const email = new AccountVerifyEmail({
      language: t,
      user: { email: "ada@example.com" },
      verificationEmailLink: "https://example.com/verify",
    });
    expect(scopeOf(email)).toEqual({ userEmail: "ada@example.com" });
  });

  it("prefers an explicit sender scope for account verification", () => {
    const email = new AccountVerifyEmail({
      language: t,
      user: { email: "ada+work@example.com" },
      verificationEmailLink: "https://example.com/verify",
      senderScope: { userId: 42 },
    });
    expect(scopeOf(email)).toEqual({ userId: 42 });
  });

  it("scopes password reset to the recipient email", () => {
    const email = new ForgotPasswordEmail({
      language: t,
      user: { email: "ada@example.com" },
      resetLink: "https://example.com/reset",
    });
    expect(scopeOf(email)).toEqual({ userEmail: "ada@example.com" });
  });

  it("scopes change of email to the current address", () => {
    const email = new ChangeOfEmailVerifyEmail({
      language: t,
      user: { emailFrom: "old@example.com", emailTo: "new@example.com" },
      verificationEmailLink: "https://example.com/verify",
    });
    expect(scopeOf(email)).toEqual({ userEmail: "old@example.com" });
  });

  it("scopes booking redirect notifications to the recipient", () => {
    const email = new BookingRedirectNotification({
      language: t,
      fromEmail: "from@example.com",
      eventOwner: "Owner",
      toEmail: "to@example.com",
      toName: "To",
      dates: "today",
      action: "add",
    });
    expect(scopeOf(email)).toEqual({ userEmail: "to@example.com" });
  });

  it("scopes disabled app emails to the recipient", () => {
    const email = new DisabledAppEmail("admin@example.com", "App", ["video"], t);
    expect(scopeOf(email)).toEqual({ userEmail: "admin@example.com" });
  });

  it("scopes broken integration emails to the event's organization", () => {
    const calEvent = {
      organizationId: 5,
      organizer: { id: 1, email: "org@example.com", language: { translate: t, locale: "en" } },
    } as unknown as CalendarEvent;
    expect(scopeOf(new BrokenIntegrationEmail(calEvent, "calendar"))).toEqual({ organizationId: 5 });
  });
});
