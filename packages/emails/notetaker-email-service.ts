import type BaseEmail from "@calcom/emails/templates/_base-email";
import type { NotetakerAttendeeNoticeEmailInput } from "./templates/attendee-notetaker-notice-email";
import AttendeeNotetakerNoticeEmail from "./templates/attendee-notetaker-notice-email";
import type { NotetakerSharedEmailInput } from "./templates/attendee-notetaker-shared-email";
import AttendeeNotetakerSharedEmail from "./templates/attendee-notetaker-shared-email";
import type { NotetakerAdmitPromptEmailInput } from "./templates/organizer-notetaker-admit-prompt-email";
import OrganizerNotetakerAdmitPromptEmail from "./templates/organizer-notetaker-admit-prompt-email";
import type { NotetakerFailedEmailInput } from "./templates/organizer-notetaker-failed-email";
import OrganizerNotetakerFailedEmail from "./templates/organizer-notetaker-failed-email";
import type { NotetakerResultsReadyEmailInput } from "./templates/organizer-notetaker-results-ready-email";
import OrganizerNotetakerResultsReadyEmail from "./templates/organizer-notetaker-results-ready-email";
import type { NotetakerTurnedOffEmailInput } from "./templates/organizer-notetaker-turned-off-email";
import OrganizerNotetakerTurnedOffEmail from "./templates/organizer-notetaker-turned-off-email";

const sendEmail = async (prepare: () => BaseEmail) => {
  let email: BaseEmail | undefined;

  try {
    email = prepare();
    return await email.sendEmail();
  } catch (e) {
    const errorName = e instanceof Error ? e.name : "UnknownError";
    console.error(
      `${email?.constructor?.name ?? "Email"}.sendEmail notetaker-email-service failed (${errorName})`,
      e
    );
    throw e;
  }
};

export const sendNotetakerResultsReadyEmail = async (
  input: NotetakerResultsReadyEmailInput
): Promise<void> => {
  await sendEmail(() => new OrganizerNotetakerResultsReadyEmail(input));
};

export const sendNotetakerAttendeeNoticeEmail = async (
  input: NotetakerAttendeeNoticeEmailInput
): Promise<void> => {
  await sendEmail(() => new AttendeeNotetakerNoticeEmail(input));
};

export const sendNotetakerAdmitPromptEmail = async (input: NotetakerAdmitPromptEmailInput): Promise<void> => {
  await sendEmail(() => new OrganizerNotetakerAdmitPromptEmail(input));
};

export const sendNotetakerFailedEmail = async (input: NotetakerFailedEmailInput): Promise<void> => {
  await sendEmail(() => new OrganizerNotetakerFailedEmail(input));
};

export const sendNotetakerTurnedOffEmail = async (input: NotetakerTurnedOffEmailInput): Promise<void> => {
  await sendEmail(() => new OrganizerNotetakerTurnedOffEmail(input));
};

export const sendNotetakerSharedEmail = async (input: NotetakerSharedEmailInput): Promise<void> => {
  await sendEmail(() => new AttendeeNotetakerSharedEmail(input));
};
