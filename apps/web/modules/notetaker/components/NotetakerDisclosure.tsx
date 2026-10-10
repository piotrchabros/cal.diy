"use client";

import { APP_NAME } from "@calcom/lib/constants";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { trpc } from "@calcom/trpc/react";
import { Alert } from "@calcom/ui/components/alert";

export function getSelectedLocationType(
  locationResponse: unknown,
  locations: { type: string }[]
): string | null {
  if (
    typeof locationResponse === "object" &&
    locationResponse !== null &&
    "value" in locationResponse &&
    typeof locationResponse.value === "string"
  ) {
    return locationResponse.value;
  }
  if (locations.length === 1) return locations[0].type;
  return null;
}

export function NotetakerDisclosure({
  eventTypeId,
  selectedLocationType,
}: {
  eventTypeId: number | null;
  selectedLocationType: string | null;
}): JSX.Element | null {
  const { t } = useLocale();
  const { data } = trpc.viewer.public.notetakerDisclosure.useQuery(
    { eventTypeId: eventTypeId ?? 0 },
    { enabled: eventTypeId !== null, retry: false, staleTime: 5 * 60 * 1000 }
  );

  if (!data?.enabledByDefault) return null;
  if (selectedLocationType === null) return null;
  if (!data.supportedLocationTypes.includes(selectedLocationType)) return null;

  return (
    <div className="mb-4" data-testid="notetaker-disclosure">
      <Alert
        severity="info"
        message={t(
          data.sharedWithColleagues === true ? "notetaker_disclosure_shared" : "notetaker_disclosure",
          {
            host: data.onBehalfOf ?? APP_NAME,
            interpolation: { escapeValue: false },
          }
        )}
      />
    </div>
  );
}
