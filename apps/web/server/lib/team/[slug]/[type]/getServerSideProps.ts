import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import type { GetBookingType } from "@calcom/features/bookings/lib/get-booking";
import type { getPublicEvent } from "@calcom/features/eventtypes/lib/getPublicEvent";
import { EventRepository } from "@calcom/features/eventtypes/repositories/EventRepository";
import { getHideBranding } from "@calcom/features/profile/lib/hideBranding";
import slugify from "@calcom/lib/slugify";
import { processReschedule, processSeatedEvent } from "@server/lib/[user]/[type]/getServerSideProps";
import type { GetServerSidePropsContext } from "next";
import { z } from "zod";

export type TeamTypePageProps = {
  eventData: NonNullable<Awaited<ReturnType<typeof getPublicEvent>>>;
  booking?: GetBookingType | null;
  rescheduleUid: string | null;
  bookingUid: string | null;
  user: string;
  slug: string;
  isTeamEvent: true;
  isBrandingHidden: boolean;
  isSEOIndexable: boolean;
  orgBannerUrl: null;
};

const paramsSchema = z.object({
  slug: z.string().min(1),
  type: z.string().min(1),
});

// Event slugs may be stored verbatim (e.g. with spaces or capitals) or slugified, so both forms are tried.
export const getEventSlugCandidates = (decoded: string): string[] => {
  const candidates = [decoded.trim(), slugify(decoded)].filter((candidate) => candidate.length > 0);
  return Array.from(new Set(candidates));
};

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  const parsedParams = paramsSchema.safeParse(context.params);
  if (!parsedParams.success) {
    return { notFound: true } as const;
  }

  const teamSlug = slugify(parsedParams.data.slug);
  if (!teamSlug) {
    return { notFound: true } as const;
  }

  const session = await getServerSession({ req: context.req });
  const { rescheduleUid, bookingUid } = context.query;
  const allowRescheduleForCancelledBooking = context.query.allowRescheduleForCancelledBooking === "true";

  let eventData: Awaited<ReturnType<typeof EventRepository.getPublicEvent>> = null;
  for (const eventSlug of getEventSlugCandidates(parsedParams.data.type)) {
    const candidate = await EventRepository.getPublicEvent(
      {
        username: teamSlug,
        eventSlug,
        isTeamEvent: true,
        org: null,
        fromRedirectOfNonOrgLink: context.query.orgRedirection === "true",
      },
      session?.user?.id
    );
    if (candidate?.teamId) {
      eventData = candidate;
      break;
    }
  }

  if (!eventData?.teamId) {
    return { notFound: true } as const;
  }

  const props: TeamTypePageProps = {
    eventData,
    user: eventData.team?.slug ?? teamSlug,
    slug: eventData.slug,
    isTeamEvent: true,
    isBrandingHidden: await getHideBranding({ teamId: eventData.teamId }),
    isSEOIndexable: true,
    bookingUid: bookingUid ? `${bookingUid}` : null,
    rescheduleUid: null,
    orgBannerUrl: null,
  };

  if (rescheduleUid) {
    const processRescheduleResult = await processReschedule({
      props,
      rescheduleUid,
      session,
      allowRescheduleForCancelledBooking,
    });
    if (processRescheduleResult) {
      return processRescheduleResult;
    }
  } else if (bookingUid) {
    const processSeatResult = await processSeatedEvent({
      props,
      bookingUid,
      allowRescheduleForCancelledBooking,
    });
    if (processSeatResult) {
      return processSeatResult;
    }
  }

  return { props };
};
