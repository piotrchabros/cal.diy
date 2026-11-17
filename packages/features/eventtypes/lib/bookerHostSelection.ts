import { SchedulingType } from "@calcom/prisma/enums";
import { eventTypeMetaDataSchemaWithoutApps } from "@calcom/prisma/zod-utils";

export const SELECTED_HOSTS_QUERY_PARAM = "cal.hosts";

export function isBookerHostSelectionEnabled(eventType: {
  schedulingType: SchedulingType | null;
  teamId?: number | null;
  metadata: unknown;
  seatsPerTimeSlot?: number | null;
}): boolean {
  if (eventType.schedulingType !== SchedulingType.COLLECTIVE) return false;
  if (eventType.teamId == null) return false;
  if (eventType.seatsPerTimeSlot) return false;
  const parsed = eventTypeMetaDataSchemaWithoutApps.safeParse(eventType.metadata);
  return parsed.success && parsed.data?.allowBookerToSelectHosts === true;
}

// Returns null when no narrowing applies, so callers can treat "everyone" and "feature off" identically.
export function resolveSelectedHostIds(args: {
  enabled: boolean;
  hosts: { id: number; email: string }[];
  requestedHostIds?: number[] | null;
  originalBooking?: { userId: number | null; attendeeEmails: string[] } | null;
}): number[] | null {
  const { enabled, hosts, requestedHostIds, originalBooking } = args;
  if (!enabled) return null;

  let selected: number[];
  if (requestedHostIds && requestedHostIds.length > 0) {
    const requested = new Set(requestedHostIds);
    selected = hosts.filter((host) => requested.has(host.id)).map((host) => host.id);
  } else if (originalBooking) {
    const attendeeEmails = new Set(originalBooking.attendeeEmails.map((email) => email.toLowerCase()));
    selected = hosts
      .filter((host) => host.id === originalBooking.userId || attendeeEmails.has(host.email.toLowerCase()))
      .map((host) => host.id);
  } else {
    return null;
  }

  if (selected.length === 0 || selected.length === hosts.length) return null;
  return selected;
}

export function filterBySelectedIds<T>(items: T[], getId: (item: T) => number, ids: number[] | null): T[] {
  if (!ids) return items;
  const allowed = new Set(ids);
  return items.filter((item) => allowed.has(getId(item)));
}

export function parseSelectedHostIdsParam(value: string | null | undefined): number[] | null {
  if (!value) return null;
  const ids: number[] = [];
  for (const part of value.split(",")) {
    const id = Number(part.trim());
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}
