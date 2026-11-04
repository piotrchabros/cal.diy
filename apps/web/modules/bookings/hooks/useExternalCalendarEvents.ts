import { trpc } from "@calcom/trpc/react";

const STALE_TIME_MS = 2 * 60 * 1000;

export function useExternalCalendarEvents({ enabled, from, to }: { enabled: boolean; from: Date; to: Date }) {
  // Provider calls are slow and rate limited, so a focus refetch would cost more than a slightly stale list.
  return trpc.viewer.bookings.externalCalendarEvents.useQuery(
    { from, to },
    { enabled, staleTime: STALE_TIME_MS, refetchOnWindowFocus: false, retry: 1 }
  );
}
