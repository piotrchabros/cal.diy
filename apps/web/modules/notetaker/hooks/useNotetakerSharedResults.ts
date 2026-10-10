"use client";

import { trpc } from "@calcom/trpc/react";

const SHARED_RESULTS_PAGE_SIZE = 20;

export function useNotetakerSharedResults() {
  return trpc.viewer.notetaker.listSharedWithMe.useInfiniteQuery(
    { limit: SHARED_RESULTS_PAGE_SIZE },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, retry: false }
  );
}
