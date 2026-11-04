import dayjs from "@calcom/dayjs";

export function formatExternalEventTimeRange(
  event: { start: Date; end: Date },
  timezone: string,
  timeFormat: string
): string {
  const start = dayjs(event.start).tz(timezone);
  const end = dayjs(event.end).tz(timezone);
  return `${start.format(timeFormat)} - ${end.format(timeFormat)}`;
}

export function formatExternalEventDate(date: Date, timezone: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: timezone,
  }).format(date);
}
