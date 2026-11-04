"use client";

import { useTimePreferences } from "@calcom/features/bookings/lib";
import type { ExternalCalendarEventDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@calcom/ui/components/dialog";
import type { NotetakerAddToMeetingInitialValues } from "@calcom/web/modules/notetaker/components/NotetakerAddToMeetingDialog";
import { NotetakerAddToMeetingDialogControlled } from "@calcom/web/modules/notetaker/components/NotetakerAddToMeetingDialog";
import { useState } from "react";
import { formatExternalCalendarLabel } from "./formatExternalCalendarLabel";
import { formatExternalEventDate, formatExternalEventTimeRange } from "./formatExternalEventTime";
import { useExternalEventNotetakerAction } from "./useExternalEventNotetakerAction";

function ExternalCalendarEventDetails({
  event,
  onAddNotetaker,
}: {
  event: ExternalCalendarEventDto;
  onAddNotetaker: (initialValues: NotetakerAddToMeetingInitialValues) => void;
}): JSX.Element {
  const { t, i18n } = useLocale();
  const { timezone, timeFormat } = useTimePreferences();
  const [now] = useState(() => new Date());

  const when = event.isAllDay
    ? t("external_calendar_event_all_day")
    : formatExternalEventTimeRange(event, timezone, timeFormat);

  return (
    <>
      <DialogHeader
        title={event.title ?? t("external_calendar_event_no_title")}
        subtitle={t("external_calendar_event_read_only")}
      />
      <div className="stack-y-2 text-emphasis text-sm" data-testid="external-calendar-event-details">
        <p data-testid="external-calendar-event-when">
          {formatExternalEventDate(new Date(event.start), timezone, i18n.language)} · {when}
        </p>
        <p className="text-subtle" data-testid="external-calendar-event-calendar">
          {formatExternalCalendarLabel(t, event.calendar)}
        </p>
        {event.attendeesCount > 0 ? (
          <p className="text-subtle" data-testid="external-calendar-event-attendees">
            {t("external_calendar_event_attendees_count", { count: event.attendeesCount })}
          </p>
        ) : null}
        <div className="pt-2">
          <ExternalCalendarEventActions
            event={event}
            now={now}
            onAddNotetaker={onAddNotetaker}
            showLaterHint
          />
        </div>
      </div>
    </>
  );
}

export function ExternalCalendarEventActions({
  event,
  now,
  onAddNotetaker,
  showLaterHint = false,
}: {
  event: ExternalCalendarEventDto;
  now: Date;
  onAddNotetaker: (initialValues: NotetakerAddToMeetingInitialValues) => void;
  showLaterHint?: boolean;
}): JSX.Element | null {
  const { t } = useLocale();
  const notetakerAction = useExternalEventNotetakerAction(event, now);
  const showHint = showLaterHint && notetakerAction.state === "later";

  if (!event.meetingUrl && notetakerAction.state !== "available" && !showHint) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {event.meetingUrl ? (
        <Button
          color="secondary"
          size="sm"
          href={event.meetingUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="external-calendar-event-join">
          {t("external_calendar_event_join")}
        </Button>
      ) : null}
      {notetakerAction.state === "available" ? (
        <Button
          color="secondary"
          size="sm"
          onClick={() => onAddNotetaker(notetakerAction.initialValues)}
          data-testid="external-calendar-event-add-notetaker">
          {t("external_calendar_event_add_notetaker")}
        </Button>
      ) : null}
      {showHint ? (
        <p className="text-sm text-subtle" data-testid="external-calendar-event-notetaker-later">
          {t("external_calendar_event_notetaker_available_later")}
        </p>
      ) : null}
    </div>
  );
}

export function ExternalCalendarEventDialog({
  event,
  onClose,
}: {
  event: ExternalCalendarEventDto | null;
  onClose: () => void;
}): JSX.Element {
  const { t } = useLocale();
  const [notetakerInitialValues, setNotetakerInitialValues] =
    useState<NotetakerAddToMeetingInitialValues | null>(null);

  return (
    <>
      <Dialog
        open={event !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}>
        <DialogContent data-testid="external-calendar-event-dialog">
          {event ? (
            <ExternalCalendarEventDetails
              event={event}
              onAddNotetaker={(initialValues) => {
                onClose();
                setNotetakerInitialValues(initialValues);
              }}
            />
          ) : null}
          <DialogFooter>
            <Button type="button" color="minimal" onClick={onClose}>
              {t("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <NotetakerAddToMeetingDialogControlled
        open={notetakerInitialValues !== null}
        onOpenChange={(open) => {
          if (!open) setNotetakerInitialValues(null);
        }}
        initialValues={notetakerInitialValues ?? undefined}
      />
    </>
  );
}
