import { APP_NAME } from "@calcom/lib/constants";

// The join request shown to participants and the notice email sent to attendees must name the same host.
export function getNotetakerHostName(organizer: { name: string | null } | null): string {
  const name = organizer?.name?.trim();
  if (!name) return APP_NAME;
  return name;
}
