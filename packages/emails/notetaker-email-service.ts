import type BaseEmail from "@calcom/emails/templates/_base-email";
import type { NotetakerResultsReadyEmailInput } from "./templates/organizer-notetaker-results-ready-email";
import OrganizerNotetakerResultsReadyEmail from "./templates/organizer-notetaker-results-ready-email";

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
