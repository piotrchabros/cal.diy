import type { ExternalCalendarEventCalendarDto } from "@calcom/lib/dto/ExternalCalendarEventDto";

const INTEGRATION_LABEL_KEYS: Record<string, string> = {
  google_calendar: "external_calendar_integration_google",
  office365_calendar: "external_calendar_integration_office365",
};

export function formatExternalCalendarLabel(
  t: (key: string) => string,
  calendar: Pick<ExternalCalendarEventCalendarDto, "integration" | "externalId">
): string {
  const labelKey = INTEGRATION_LABEL_KEYS[calendar.integration];
  const integrationLabel = labelKey ? t(labelKey) : calendar.integration;
  return `${integrationLabel} · ${calendar.externalId}`;
}
