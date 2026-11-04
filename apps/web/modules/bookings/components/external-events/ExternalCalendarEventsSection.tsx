"use client";

import { useTimePreferences } from "@calcom/features/bookings/lib";
import type { ExternalCalendarEventDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import { SkeletonText } from "@calcom/ui/components/skeleton";
import type { NotetakerAddToMeetingInitialValues } from "@calcom/web/modules/notetaker/components/NotetakerAddToMeetingDialog";
import { NotetakerAddToMeetingDialogControlled } from "@calcom/web/modules/notetaker/components/NotetakerAddToMeetingDialog";
import { ChevronDownIcon, ChevronRightIcon } from "@coss/ui/icons";
import { useState } from "react";
import { useExternalCalendarEvents } from "../../hooks/useExternalCalendarEvents";
import { ExternalCalendarEventActions } from "./ExternalCalendarEventDialog";
import { formatExternalCalendarLabel } from "./formatExternalCalendarLabel";
import { formatExternalEventDate, formatExternalEventTimeRange } from "./formatExternalEventTime";

const COLLAPSED_ROW_LIMIT = 10;
const WINDOW_STEP_MS = 5 * 60 * 1000;
const WINDOW_LENGTH_MS = 7 * 24 * 60 * 60 * 1000;

// Flooring keeps the query key stable across remounts so the cached result is reused.
function getUpcomingWindow(nowMs: number): { from: Date; to: Date } {
  const fromMs = Math.floor(nowMs / WINDOW_STEP_MS) * WINDOW_STEP_MS;
  return { from: new Date(fromMs), to: new Date(fromMs + WINDOW_LENGTH_MS) };
}

function ExternalCalendarEventRow({
  event,
  now,
  onAddNotetaker,
}: {
  event: ExternalCalendarEventDto;
  now: Date;
  onAddNotetaker: (initialValues: NotetakerAddToMeetingInitialValues) => void;
}): JSX.Element {
  const { t, i18n } = useLocale();
  const { timezone, timeFormat } = useTimePreferences();
  const when = event.isAllDay
    ? t("external_calendar_event_all_day")
    : formatExternalEventTimeRange(event, timezone, timeFormat);

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
      data-testid="external-calendar-event-row">
      <div className="min-w-0">
        <p className="text-sm text-subtle">
          {formatExternalEventDate(new Date(event.start), timezone, i18n.language)} · {when}
        </p>
        <p className="truncate font-medium text-emphasis text-sm">
          {event.title ?? t("external_calendar_event_no_title")}
        </p>
        <p className="text-sm text-subtle">
          {formatExternalCalendarLabel(t, event.calendar)}
          {event.attendeesCount > 0
            ? ` · ${t("external_calendar_event_attendees_count", { count: event.attendeesCount })}`
            : null}
        </p>
      </div>
      <ExternalCalendarEventActions event={event} now={now} onAddNotetaker={onAddNotetaker} />
    </li>
  );
}

export function ExternalCalendarEventsSection({ enabled }: { enabled: boolean }): JSX.Element | null {
  const { t } = useLocale();
  const [range] = useState(() => getUpcomingWindow(Date.now()));
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [notetakerInitialValues, setNotetakerInitialValues] =
    useState<NotetakerAddToMeetingInitialValues | null>(null);
  const query = useExternalCalendarEvents({ enabled, from: range.from, to: range.to });

  if (!enabled || query.isError) return null;

  if (query.isPending) {
    return (
      <div
        className="mt-4 rounded-xl border border-subtle p-4"
        data-testid="external-calendar-events-loading">
        <SkeletonText className="h-4 w-48" />
        <SkeletonText className="mt-3 h-4 w-full" />
      </div>
    );
  }

  const { available, events, failedCalendarCount } = query.data;
  if (!available || events.length === 0) return null;

  const now = new Date();
  const visibleEvents = showAll ? events : events.slice(0, COLLAPSED_ROW_LIMIT);
  const ToggleIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <section className="mt-4 rounded-xl border border-subtle" data-testid="external-calendar-events-section">
      <button
        type="button"
        className="flex w-full items-start gap-2 p-4 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        data-testid="external-calendar-events-toggle">
        <ToggleIcon className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
        <span>
          <span className="font-semibold text-emphasis text-sm">
            {t("external_calendar_events_section_title")}
          </span>
          <span className="ml-2 text-sm text-subtle" data-testid="external-calendar-events-count">
            {events.length}
          </span>
          <span className="block text-sm text-subtle">
            {t("external_calendar_events_section_description")}
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="border-subtle border-t">
          <ul className="divide-y divide-subtle">
            {visibleEvents.map((event) => (
              <ExternalCalendarEventRow
                key={event.key}
                event={event}
                now={now}
                onAddNotetaker={setNotetakerInitialValues}
              />
            ))}
          </ul>
          {events.length > COLLAPSED_ROW_LIMIT ? (
            <div className="border-subtle border-t px-4 py-2">
              <Button
                color="minimal"
                size="sm"
                onClick={() => setShowAll((value) => !value)}
                data-testid="external-calendar-events-show-all">
                {showAll
                  ? t("external_calendar_events_show_less")
                  : t("external_calendar_events_show_all", { count: events.length })}
              </Button>
            </div>
          ) : null}
          {failedCalendarCount > 0 ? (
            <p
              className="border-subtle border-t px-4 py-2 text-muted text-sm"
              data-testid="external-calendar-events-some-failed">
              {t("external_calendar_events_some_failed")}
            </p>
          ) : null}
        </div>
      ) : null}
      <NotetakerAddToMeetingDialogControlled
        open={notetakerInitialValues !== null}
        onOpenChange={(open) => {
          if (!open) setNotetakerInitialValues(null);
        }}
        initialValues={notetakerInitialValues ?? undefined}
      />
    </section>
  );
}
