"use client";

import dayjs from "@calcom/dayjs";
import { useTimePreferences } from "@calcom/features/bookings/lib";
import type { CalendarEvent } from "@calcom/features/calendars/weeklyview/types/events";
import type { ExternalCalendarEventDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { useGetTheme } from "@calcom/lib/hooks/useTheme";
import { Calendar } from "@calcom/web/modules/calendars/weeklyview/components/Calendar";
import { useBanners } from "@calcom/web/modules/shell/banners/useBanners";
import { useEffect, useMemo, useState } from "react";
import { EXTERNAL_EVENT_ID_BASE, toWeekCalendarEvents } from "../lib/externalEventsToCalendarEvents";
import { useBookingDetailsSheetStore } from "../store/bookingDetailsSheetStore";
import type { BookingOutput } from "../types";
import { ExternalCalendarEventDialog } from "./external-events/ExternalCalendarEventDialog";
import { formatExternalCalendarLabel } from "./external-events/formatExternalCalendarLabel";

type BookingCalendarViewProps = {
  bookings: BookingOutput[];
  currentWeekStart: dayjs.Dayjs;
  onWeekStartChange: (weekStart: dayjs.Dayjs) => void;
  externalEvents?: ExternalCalendarEventDto[];
};

export function BookingCalendarView({
  bookings,
  currentWeekStart,
  onWeekStartChange,
  externalEvents,
}: BookingCalendarViewProps) {
  const { t } = useLocale();
  const setSelectedBookingUid = useBookingDetailsSheetStore((state) => state.setSelectedBookingUid);
  const selectedBookingUid = useBookingDetailsSheetStore((state) => state.selectedBookingUid);
  const { timezone } = useTimePreferences();
  const { resolvedTheme, forcedTheme } = useGetTheme();
  const { bannersHeight } = useBanners();
  const [selectedExternalEvent, setSelectedExternalEvent] = useState<ExternalCalendarEventDto | null>(null);

  const startDate = useMemo(() => currentWeekStart.toDate(), [currentWeekStart]);
  const endDate = useMemo(() => currentWeekStart.add(6, "day").toDate(), [currentWeekStart]);

  // Intentionally only runs on mount to trigger the initial currentWeekStart
  useEffect(() => {
    onWeekStartChange(currentWeekStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bookingEvents = useMemo<CalendarEvent[]>(() => {
    const hasDarkTheme = !forcedTheme && resolvedTheme === "dark";

    return bookings
      .filter((booking) => {
        const bookingStart = dayjs(booking.startTime);
        return (
          (bookingStart.isAfter(currentWeekStart) || bookingStart.isSame(currentWeekStart)) &&
          bookingStart.isBefore(currentWeekStart.add(7, "day"))
        );
      })
      .sort((a, b) => {
        const startDiff = new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
        if (startDiff !== 0) return startDiff;
        return new Date(a.endTime).getTime() - new Date(b.endTime).getTime();
      })
      .map((booking, idx) => {
        // Parse eventTypeColor and extract the appropriate color based on theme
        const eventTypeColor =
          booking.eventType?.eventTypeColor &&
          booking.eventType.eventTypeColor[hasDarkTheme ? "darkEventTypeColor" : "lightEventTypeColor"];

        return {
          id: idx,
          title: booking.title,
          start: new Date(booking.startTime),
          end: new Date(booking.endTime),
          options: {
            status: booking.status,
            ...(eventTypeColor && { color: eventTypeColor }),
            bookingUid: booking.uid,
          },
        };
      });
  }, [bookings, currentWeekStart, resolvedTheme, forcedTheme]);

  const externalWeekEvents = useMemo(
    () =>
      toWeekCalendarEvents(
        externalEvents ?? [],
        currentWeekStart.toDate(),
        currentWeekStart.add(7, "day").toDate(),
        (event) => formatExternalCalendarLabel(t, event.calendar),
        t("external_calendar_event_no_title")
      ),
    [externalEvents, currentWeekStart, t]
  );

  const events = useMemo(
    () => [...bookingEvents, ...externalWeekEvents.events],
    [bookingEvents, externalWeekEvents]
  );

  return (
    <>
      <div
        className="border-subtle flex flex-1 flex-col overflow-y-auto overflow-x-hidden rounded-2xl border"
        style={{ height: `calc(100vh - 6rem - ${bannersHeight}px)` }}>
        <Calendar
          timezone={timezone}
          sortEvents
          startHour={0}
          endHour={23}
          events={events}
          startDate={startDate}
          endDate={endDate}
          gridCellsPerHour={4}
          hoverEventDuration={0}
          showBackgroundPattern={false}
          showBorder={false}
          borderColor="subtle"
          selectedBookingUid={selectedBookingUid}
          onEventClick={(event) => {
            if (event.id >= EXTERNAL_EVENT_ID_BASE) {
              setSelectedExternalEvent(externalWeekEvents.byId.get(event.id) ?? null);
              return;
            }
            const bookingUid = event.options?.bookingUid;
            if (bookingUid) {
              setSelectedBookingUid(bookingUid);
            }
          }}
          showTimezone
          hideHeader
          updateCurrentTimeOnFocus
        />
      </div>
      {externalEvents ? (
        <ExternalCalendarEventDialog
          event={selectedExternalEvent}
          onClose={() => setSelectedExternalEvent(null)}
        />
      ) : null}
    </>
  );
}
