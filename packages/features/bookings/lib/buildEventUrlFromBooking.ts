import { getOrganizationUrlService } from "@calcom/features/organizations/di/OrganizationUrlService.container";
import logger from "@calcom/lib/logger";
import { getTeamOrganizationId } from "@calcom/lib/organizations/getTeamOrganizationId";
import { safeStringify } from "@calcom/lib/safeStringify";

type BookingEventType = {
  slug: string;
  team: {
    id: number;
    slug: string | null;
    isOrganization: boolean;
    parentId: number | null;
  } | null;
};

/**
 * It has its profile always set and if organizationId is null, then username would be regular(non-org) username.
 */
type ProfileEnrichedBookingUser = {
  profile: { organizationId: number | null; username: string | null };
} | null;

export function getOrganizationIdOfBooking(booking: {
  eventType: BookingEventType;
  profileEnrichedBookingUser: ProfileEnrichedBookingUser;
}) {
  const { eventType, profileEnrichedBookingUser } = booking;
  return eventType.team
    ? getTeamOrganizationId(eventType.team)
    : (profileEnrichedBookingUser?.profile.organizationId ?? null);
}

export async function buildEventUrlFromBooking(booking: {
  eventType: BookingEventType;
  profileEnrichedBookingUser: ProfileEnrichedBookingUser;
  dynamicGroupSlugRef: string | null;
}) {
  const { eventType, dynamicGroupSlugRef, profileEnrichedBookingUser } = booking;
  const eventSlug = eventType.slug;
  const eventTeam = eventType.team;
  const bookingOrganizationId = getOrganizationIdOfBooking({ eventType, profileEnrichedBookingUser });

  const bookerUrl = await getOrganizationUrlService().getBaseUrl({ organizationId: bookingOrganizationId });
  if (dynamicGroupSlugRef) {
    return `${bookerUrl}/${dynamicGroupSlugRef}/${eventSlug}`;
  }

  if (eventTeam?.slug) {
    return `${bookerUrl}/team/${eventTeam.slug}/${eventSlug}`;
  }

  const username = profileEnrichedBookingUser?.profile?.username;
  if (!username) {
    logger.error("No username found for booking user.", safeStringify({ profileEnrichedBookingUser }));
    throw new Error("No username found for booking user.");
  }
  return `${bookerUrl}/${username}/${eventSlug}`;
}
