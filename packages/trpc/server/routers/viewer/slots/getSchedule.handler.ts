import { getAvailableSlotsService } from "@calcom/features/di/containers/AvailableSlots";
import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { toHeaderGetter } from "@calcom/features/organizations/lib/orgRequestHeaders";
import {
  assertEventTypeInHostOrganization,
  getEventTypeOrganizationId,
} from "@calcom/features/organizations/lib/resolveBookingHostOrganization";
import type { RequestOrganizationDto } from "@calcom/lib/dto/OrganizationDto";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { prisma } from "@calcom/prisma";
import { TRPCError } from "@trpc/server";
import type { GetScheduleOptions, TGetScheduleInputSchema } from "./types";

// The client-supplied orgSlug is untrusted: with organizations on, the org the proxy resolved for this
// request wins, so slot lookups and the slots cache key are scoped to that org. Done here rather than in
// the service because apps/api/v2 calls the service directly without the proxy headers.
async function withRequestOrgSlug(
  input: TGetScheduleInputSchema,
  ctx: GetScheduleOptions["ctx"]
): Promise<TGetScheduleInputSchema> {
  if (!isOrganizationsEnabled() || !ctx?.req) return input;
  const { getOrgFromRequest } = await import("@calcom/features/organizations/lib/getOrgFromRequest");
  const org = await getOrgFromRequest(toHeaderGetter(ctx.req.headers));
  await assertDirectEventTypeInRequestOrg(input.eventTypeId, org);
  return { ...input, orgSlug: org?.slug ?? null };
}

// The orgSlug override only scopes slug lookups; a direct eventTypeId must be checked against the
// request organization too, or any organization's availability could be read from another domain.
async function assertDirectEventTypeInRequestOrg(
  eventTypeId: number | undefined,
  org: RequestOrganizationDto | null
): Promise<void> {
  if (!eventTypeId) return;
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "event_not_found" });

  const eventType = await new EventTypeRepository(prisma).findByIdIncludeTeamAndOwnerOrganization({
    id: eventTypeId,
  });
  // A missing event type is left to the slots service, which already answers it.
  if (!eventType) return;

  assertEventTypeInHostOrganization({
    hostOrganization: org,
    eventTypeOrganizationId: getEventTypeOrganizationId(eventType),
    eventTypeId: eventType.id,
  });
}

export const getScheduleHandler = async ({ ctx, input }: GetScheduleOptions) => {
  const availableSlotsService = getAvailableSlotsService();
  return await availableSlotsService.getAvailableSlots({ ctx, input: await withRequestOrgSlug(input, ctx) });
};
