"use client";

import { NOTETAKER_LIVE_SESSION_STATUSES } from "@calcom/features/notetaker/lib/sessionStateMachine";
import { trpc } from "@calcom/trpc/react";

export const NOTETAKER_STATE_POLL_INTERVAL_MS = 5000;

export function useNotetakerState(bookingUid: string) {
  return trpc.viewer.notetaker.getState.useQuery(
    { bookingUid },
    {
      retry: false,
      refetchInterval: (query) => {
        // After an error, `data` can still hold the last good value; stop polling instead of hammering a failing endpoint.
        if (query.state.status === "error") return false;
        const status = query.state.data?.status;
        if (!status) return false;
        return NOTETAKER_LIVE_SESSION_STATUSES.includes(status) ? NOTETAKER_STATE_POLL_INTERVAL_MS : false;
      },
    }
  );
}
