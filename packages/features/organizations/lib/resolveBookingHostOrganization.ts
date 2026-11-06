import type { RequestOrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";

type EventTypeOrganizationSource = {
  team?: { id: number; parentId: number | null; isOrganization?: boolean } | null;
  parent?: { team?: { parentId: number | null } | null } | null;
  owner?: { organizationId?: number | null } | null;
};

export type BookingHostOrganization = {
  orgSlug: string | null;
  hostOrganization: RequestOrganizationDto | null;
};

export async function resolveBookingHostOrganization(args: {
  hostname: string | null | undefined;
  forcedSlug: string | null | undefined;
  isPlatform: boolean;
}): Promise<BookingHostOrganization> {
  // The resolver returns the default organization while the feature is off, so it must not run at all.
  if (!isOrganizationsEnabled()) return { orgSlug: null, hostOrganization: null };

  if (args.isPlatform) return { orgSlug: args.forcedSlug ?? null, hostOrganization: null };

  if (args.hostname) {
    // Loaded lazily so the flag-off and platform paths never pull in Prisma.
    const { getOrganizationDomainResolver } = await import("../di/OrganizationDomainResolver.container");
    const org = await getOrganizationDomainResolver().resolve(args.hostname);
    // The host organization wins over forcedSlug because the web booking endpoint forwards the
    // client-controlled x-cal-force-slug header, which must not let a booker switch organizations.
    if (org) return { orgSlug: org.slug, hostOrganization: org };
  }

  return { orgSlug: args.forcedSlug ?? null, hostOrganization: null };
}

export function getEventTypeOrganizationId(eventType: EventTypeOrganizationSource): number | null {
  const { team, parent, owner } = eventType;
  const teamOrganizationId = team ? (team.parentId ?? (team.isOrganization ? team.id : null)) : null;
  return teamOrganizationId ?? parent?.team?.parentId ?? owner?.organizationId ?? null;
}

export function assertEventTypeInHostOrganization(args: {
  hostOrganization: RequestOrganizationDto | null;
  eventTypeOrganizationId: number | null;
  eventTypeId: number | null | undefined;
}): void {
  const { hostOrganization, eventTypeOrganizationId, eventTypeId } = args;
  // Dynamic group events have id 0 and no single owning organization to check.
  if (!hostOrganization || !eventTypeId) return;
  if (eventTypeOrganizationId === hostOrganization.id) return;
  // Event types outside any organization belong to the default organization's domain.
  if (eventTypeOrganizationId === null && hostOrganization.isDefault) return;

  throw new ErrorWithCode(ErrorCode.NotFound, "event_not_found");
}
