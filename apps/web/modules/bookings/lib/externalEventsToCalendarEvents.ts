import type { CalendarEvent } from "@calcom/features/calendars/weeklyview/types/events";
import type { ExternalCalendarEventDto } from "@calcom/lib/dto/ExternalCalendarEventDto";

// Bookings use their array index as the week view id, so external ids start far above any realistic week's count.
export const EXTERNAL_EVENT_ID_BASE = 1_000_000;

export function toWeekCalendarEvents(
  events: ExternalCalendarEventDto[],
  weekStart: Date,
  weekEnd: Date,
  labelFor: (event: ExternalCalendarEventDto) => string,
  untitledLabel = ""
): { events: CalendarEvent[]; byId: Map<number, ExternalCalendarEventDto> } {
  const weekStartMs = weekStart.getTime();
  const weekEndMs = weekEnd.getTime();
  const calendarEvents: CalendarEvent[] = [];
  const byId = new Map<number, ExternalCalendarEventDto>();

  for (const event of events) {
    // The week view has no all-day row, so these only appear in the upcoming list.
    if (event.isAllDay) continue;
    const startMs = new Date(event.start).getTime();
    if (startMs < weekStartMs || startMs >= weekEndMs) continue;

    const id = EXTERNAL_EVENT_ID_BASE + calendarEvents.length;
    byId.set(id, event);
    calendarEvents.push({
      id,
      title: event.title ?? untitledLabel,
      description: labelFor(event),
      start: new Date(event.start),
      end: new Date(event.end),
      options: { borderOnly: true, className: "text-subtle" },
    });
  }

  return { events: calendarEvents, byId };
}
