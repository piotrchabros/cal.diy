"use client";

import type { NotetakerSharedResultDto } from "@calcom/lib/dto/NotetakerSharedResultDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import { EmptyScreen } from "@calcom/ui/components/empty-screen";
import Link from "next/link";
import { useNotetakerSharedResults } from "../hooks/useNotetakerSharedResults";

export function NotetakerSharedResultsList(): JSX.Element | null {
  const { t, i18n } = useLocale();
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useNotetakerSharedResults();

  if (isPending || isError || !data) return null;

  const items = data.pages.flatMap((page) => page.items);
  const formatter = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" });

  const getRouteText = (item: NotetakerSharedResultDto): string =>
    item.route === "TEAM"
      ? t("notetaker_shared_with_me_route_team", { teamName: item.teamName })
      : t("notetaker_shared_with_me_route_selected_people");

  // A page can be empty while a cursor is set, so the empty screen waits until the last page.
  const showEmpty = items.length === 0 && !hasNextPage;

  return (
    <div className="flex flex-col gap-4">
      {showEmpty ? (
        <EmptyScreen
          Icon="file-text"
          headline={t("notetaker_shared_with_me_empty_title")}
          description={t("notetaker_shared_with_me_empty_description")}
        />
      ) : null}
      {items.length > 0 ? (
        <ul className="divide-y divide-subtle rounded-md border border-subtle">
          {items.map((item) => (
            <li key={item.bookingUid}>
              <Link
                href={`/booking/${item.bookingUid}/notetaker`}
                data-testid="notetaker-shared-result"
                className="flex flex-col gap-1 p-4 hover:bg-muted">
                <span className="font-medium text-emphasis text-sm">{item.title}</span>
                <span className="text-sm text-subtle">
                  {formatter.format(new Date(item.startTime))} · {item.eventTypeTitle}
                </span>
                {item.hostName !== null ? (
                  <span className="text-sm text-subtle">
                    {t("notetaker_shared_with_me_host", { name: item.hostName })}
                  </span>
                ) : null}
                <span className="text-subtle text-xs">{getRouteText(item)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {hasNextPage ? (
        <div>
          <Button
            color="secondary"
            data-testid="notetaker-shared-load-more"
            loading={isFetchingNextPage}
            onClick={() => fetchNextPage()}>
            {t("notetaker_shared_with_me_load_more")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
