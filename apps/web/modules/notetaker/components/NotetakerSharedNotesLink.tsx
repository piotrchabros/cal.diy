"use client";

import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import Link from "next/link";

const LINK_STALE_TIME_MS = 5 * 60 * 1000;

export function NotetakerSharedNotesLink(): JSX.Element | null {
  const { t } = useLocale();
  const { data } = trpc.viewer.notetaker.listSharedWithMe.useQuery(
    { limit: 1 },
    { retry: false, staleTime: LINK_STALE_TIME_MS }
  );

  // An empty first page can still carry a cursor, because rows are filtered after the page is cut.
  if (!data || (data.items.length === 0 && data.nextCursor === null)) return null;

  return (
    <Link
      href="/bookings/shared-notes"
      data-testid="notetaker-shared-notes-link"
      className="font-medium text-emphasis text-sm underline">
      {t("notetaker_shared_with_me_link")}
    </Link>
  );
}
