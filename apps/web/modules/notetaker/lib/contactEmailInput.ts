import { MAX_MANUAL_CONTACTS, parseContactEmailInput } from "@calcom/features/notetaker/lib/meetingContacts";
import { emailSchema } from "@calcom/lib/emailSchema";

export type ContactEmailInputError = "INVALID" | "TOO_MANY";

export type ContactEmailInputResult = { emails: string[]; error: ContactEmailInputError | null };

export function validateContactEmailInput(text: string): ContactEmailInputResult {
  const emails = Array.from(new Set(parseContactEmailInput(text).map((part) => part.toLowerCase())));
  if (emails.some((email) => !emailSchema.safeParse(email).success)) return { emails, error: "INVALID" };
  if (emails.length > MAX_MANUAL_CONTACTS) return { emails, error: "TOO_MANY" };
  return { emails, error: null };
}

export const CONTACT_EMAIL_ERROR_KEYS: Record<ContactEmailInputError, string> = {
  INVALID: "notetaker_contact_emails_invalid",
  TOO_MANY: "notetaker_contact_emails_too_many",
};
