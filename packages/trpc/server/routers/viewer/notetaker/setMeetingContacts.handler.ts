import { getNotetakerAdHocService } from "@calcom/features/notetaker/di/NotetakerAdHocService.container";
import type { NotetakerMeetingContactRecord } from "@calcom/features/notetaker/repositories/interfaces/INotetakerMeetingContactRepository";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import type { TSetMeetingContactsInputSchema } from "./setMeetingContacts.schema";

type SetMeetingContactsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TSetMeetingContactsInputSchema;
};

export const setMeetingContactsHandler = async ({
  ctx,
  input,
}: SetMeetingContactsOptions): Promise<{ meetingContacts: NotetakerMeetingContactRecord[] }> => {
  await checkRateLimitAndThrowError({
    identifier: `notetaker.setMeetingContacts:${ctx.user.id}`,
    rateLimitingType: "core",
  });

  return getNotetakerAdHocService().setMeetingContacts({
    userId: ctx.user.id,
    bookingUid: input.bookingUid,
    emails: input.emails,
  });
};
