export function getTeamEventBookingUrl(teamSlug: string | null, eventSlug: string): string {
  return `/team/${teamSlug}/${eventSlug}`;
}
