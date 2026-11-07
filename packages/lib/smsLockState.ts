import { prisma } from "@calcom/prisma";
import { SMSLockState } from "@calcom/prisma/enums";
import { outsideOrganizationsFilter } from "./organizations/outsideOrganizationsFilter";
import type { RateLimitHelper } from "./rateLimit";
import { rateLimiter } from "./rateLimit";

export async function checkSMSRateLimit({
  rateLimitingType = "sms",
  identifier,
  onRateLimiterResponse,
  opts,
}: RateLimitHelper) {
  const response = await rateLimiter()({ rateLimitingType, identifier, opts });
  const { success } = response;

  if (onRateLimiterResponse) onRateLimiterResponse(response);

  if (!success) {
    await changeSMSLockState(
      identifier,
      rateLimitingType === "sms" ? SMSLockState.LOCKED : SMSLockState.REVIEW_NEEDED
    );
  }
}

async function changeSMSLockState(identifier: string, status: SMSLockState) {
  let userId: number | undefined, teamId: number | undefined;

  if (identifier.startsWith("sms:user:")) {
    userId = Number(identifier.slice(9));
  } else if (identifier.startsWith("sms:team:")) {
    teamId = Number(identifier.slice(9));
  }

  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId, ...outsideOrganizationsFilter({ profiles: { none: {} } }) },
    });
    if (user?.smsLockReviewedByAdmin) return;

    await prisma.user.update({
      where: {
        id: userId,
        ...outsideOrganizationsFilter({ profiles: { none: {} } }),
      },
      data: {
        smsLockState: status,
      },
    });
  } else {
    const team = await prisma.team.findUnique({
      where: { id: teamId, ...outsideOrganizationsFilter({ parentId: null }), isOrganization: false },
    });
    if (team?.smsLockReviewedByAdmin) return;

    await prisma.team.update({
      where: {
        id: teamId,
        ...outsideOrganizationsFilter({ parentId: null }),
        isOrganization: false,
      },
      data: {
        smsLockState: status,
      },
    });
  }
}
