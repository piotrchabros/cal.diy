import { emailSchema } from "@calcom/lib/emailSchema";

export const MAX_MANUAL_CONTACTS = 20;
export const MAX_CALENDAR_CONTACTS = 50;

export type MeetingContact = { email: string; name: string | null };

const RESOURCE_EMAIL_PATTERNS = [
  /@resource\.calendar\.google\.com$/i,
  /^room[-_.][^@]*@.*\.onmicrosoft\.com$/i,
];

export function isCalendarResourceEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return RESOURCE_EMAIL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email || !emailSchema.safeParse(email).success) return null;
  return email;
}

export function normalizeMeetingContacts(
  raw: MeetingContact[],
  excludeEmails: string[],
  max: number
): MeetingContact[] {
  const excluded = new Set(excludeEmails.map((email) => email.trim().toLowerCase()));
  const byEmail = new Map<string, MeetingContact>();
  for (const entry of raw) {
    const email = normalizeEmail(entry.email);
    if (!email || excluded.has(email) || isCalendarResourceEmail(email)) continue;
    const name = entry.name?.trim() || null;
    const existing = byEmail.get(email);
    if (existing) {
      if (!existing.name && name) existing.name = name;
      continue;
    }
    byEmail.set(email, { email, name });
  }
  return Array.from(byEmail.values()).slice(0, Math.max(0, max));
}

export function normalizeMeetingContactEmails(raw: string[], excludeEmails: string[], max: number): string[] {
  return normalizeMeetingContacts(
    raw.map((email) => ({ email, name: null })),
    excludeEmails,
    max
  ).map((contact) => contact.email);
}

export function parseContactEmailInput(text: string): string[] {
  return text.split(/[,;\s]+/).filter((part) => part.length > 0);
}
