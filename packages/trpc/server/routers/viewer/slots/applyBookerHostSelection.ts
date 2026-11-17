import {
  filterBySelectedIds,
  isBookerHostSelectionEnabled,
  resolveSelectedHostIds,
} from "@calcom/features/eventtypes/lib/bookerHostSelection";
import type { SchedulingType } from "@calcom/prisma/enums";

type HostWithUserId = { user: { id: number } };

type OriginalBooking = { userId: number | null; attendees: { email: string }[] } | null;

export async function applyBookerHostSelection<TFixed extends HostWithUserId, TRR extends HostWithUserId>({
  eventType,
  rrHostSubsetIds,
  rescheduleUid,
  fixedHosts,
  qualifiedRRHosts,
  findOriginalBooking,
}: {
  eventType: {
    schedulingType: SchedulingType | null;
    team?: { id: number } | null;
    metadata: unknown;
    seatsPerTimeSlot?: number | null;
    hosts: { user: { id: number; email: string } }[];
  };
  rrHostSubsetIds?: number[] | null;
  rescheduleUid?: string | null;
  fixedHosts: TFixed[];
  qualifiedRRHosts: TRR[];
  findOriginalBooking: (rescheduleUid: string) => Promise<OriginalBooking>;
}): Promise<{ fixedHosts: TFixed[]; qualifiedRRHosts: TRR[] }> {
  const enabled = isBookerHostSelectionEnabled({
    schedulingType: eventType.schedulingType,
    teamId: eventType.team?.id ?? null,
    metadata: eventType.metadata,
    seatsPerTimeSlot: eventType.seatsPerTimeSlot,
  });
  if (!enabled) return { fixedHosts, qualifiedRRHosts };

  // On reschedule without an explicit subset, keep the hosts of the original booking
  const originalBooking =
    !rrHostSubsetIds?.length && rescheduleUid ? await findOriginalBooking(rescheduleUid) : null;

  const selectedIds = resolveSelectedHostIds({
    enabled,
    hosts: eventType.hosts.map((host) => ({ id: host.user.id, email: host.user.email })),
    requestedHostIds: rrHostSubsetIds,
    originalBooking: originalBooking
      ? {
          userId: originalBooking.userId,
          attendeeEmails: originalBooking.attendees.map((attendee) => attendee.email),
        }
      : null,
  });

  return {
    fixedHosts: filterBySelectedIds(fixedHosts, (host) => host.user.id, selectedIds),
    qualifiedRRHosts: filterBySelectedIds(qualifiedRRHosts, (host) => host.user.id, selectedIds),
  };
}
