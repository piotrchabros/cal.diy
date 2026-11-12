import type {
  EmailSenderScope,
  OrganizationEmailSenderDto,
} from "@calcom/lib/dto/OrganizationEmailSenderDto";
import type { CalendarEvent } from "@calcom/types/Calendar";

type ParsedFrom = { name: string | null; address: string };

export const parseFromHeader = (from: string): ParsedFrom => {
  const match = from.trim().match(/^(.*?)\s*<(.*)>$/);
  if (!match) return { name: null, address: from.trim() };
  const name = match[1].trim();
  return { name: name || null, address: match[2].trim() };
};

export const applyOrganizationSender = (
  from: string,
  sender: OrganizationEmailSenderDto,
  defaults: { address: string; systemNames: string[] }
): { from: string; customized: boolean } => {
  const parsed = parseFromHeader(from);
  let { name, address } = parsed;

  if (sender.address && address.toLowerCase() === defaults.address.trim().toLowerCase()) {
    address = sender.address;
  }

  // Only names we put there ourselves are replaced; an organizer's name on attendee emails stays.
  if (sender.name && name !== null && defaults.systemNames.includes(name)) {
    name = sender.name;
  }

  const customized = name !== parsed.name || address !== parsed.address;
  if (!customized) return { from, customized: false };

  return { from: name ? `${name} <${address}>` : address, customized: true };
};

export const senderScopeFromCalEvent = (
  calEvent: Pick<CalendarEvent, "organizationId" | "organizer">
): EmailSenderScope | null => {
  if (typeof calEvent.organizationId === "number") return { organizationId: calEvent.organizationId };
  if (typeof calEvent.organizer?.id === "number") return { userId: calEvent.organizer.id };
  if (calEvent.organizer?.email) return { userEmail: calEvent.organizer.email };
  return null;
};
