import { eventTypeLocations } from "@calcom/lib/zod/eventType";

export function parseEventTypeLocations(locations: unknown): { type: string }[] {
  const parsed = eventTypeLocations.safeParse(locations);
  // An empty list is how Cal.com stores "no location", which the availability check reads as Cal Video.
  if (!parsed.success) return [];
  return parsed.data;
}
