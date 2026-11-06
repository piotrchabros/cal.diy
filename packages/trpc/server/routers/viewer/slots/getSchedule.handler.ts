import { getAvailableSlotsService } from "@calcom/features/di/containers/AvailableSlots";
import { toHeaderGetter } from "@calcom/features/organizations/lib/orgRequestHeaders";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
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
  return { ...input, orgSlug: org?.slug ?? null };
}

export const getScheduleHandler = async ({ ctx, input }: GetScheduleOptions) => {
  const availableSlotsService = getAvailableSlotsService();
  return await availableSlotsService.getAvailableSlots({ ctx, input: await withRequestOrgSlug(input, ctx) });
};
