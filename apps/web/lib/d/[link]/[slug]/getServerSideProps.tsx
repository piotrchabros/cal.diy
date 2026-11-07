import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import type { GetBookingType } from "@calcom/features/bookings/lib/get-booking";
import { getBookingForReschedule, getMultipleDurationValue } from "@calcom/features/bookings/lib/get-booking";
import { EventRepository } from "@calcom/features/eventtypes/repositories/EventRepository";
import { HashedLinkService } from "@calcom/features/hashedLink/lib/service/HashedLinkService";
import { getHostOrganization } from "@calcom/features/organizations/lib/getHostOrganization";
import {
  shouldHideBrandingForTeamEvent,
  shouldHideBrandingForUserEvent,
} from "@calcom/features/profile/lib/hideBranding";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import slugify from "@calcom/lib/slugify";
import prisma from "@calcom/prisma";
import { RedirectType } from "@calcom/prisma/enums";
import { getRedirectWithOriginAndSearchString, omitRouteParams } from "@lib/handleOrgRedirect";
import type { inferSSRProps } from "@lib/types/inferSSRProps";
import type { EmbedProps } from "app/WithEmbedSSR";
import type { GetServerSidePropsContext } from "next";
import { z } from "zod";

export type PageProps = inferSSRProps<typeof getServerSideProps> & EmbedProps;

async function getUserPageProps(context: GetServerSidePropsContext) {
  const host = await getHostOrganization(context.req.headers);
  if (host.status === "unresolved") return { notFound: true } as const;
  const hostOrg = host.status === "resolved" ? host.org : null;
  const orgSlug = hostOrg?.slug ?? null;

  const session = await getServerSession({ req: context.req });
  const { link, slug } = paramsSchema.parse(context.params);
  const { rescheduleUid, duration: queryDuration } = context.query;

  let name: string;
  let hideBranding = false;

  const notFound = {
    notFound: true,
  } as const;

  // Use centralized validation logic to avoid duplication
  const hashedLinkService = new HashedLinkService();
  try {
    await hashedLinkService.validate(link);
  } catch (_error) {
    // Link is expired, invalid, or doesn't exist
    return notFound;
  }

  // If validation passes, fetch the complete data needed for rendering
  const hashedLink = await hashedLinkService.findLinkWithDetails(link);

  if (!hashedLink) {
    return notFound;
  }

  const username = hashedLink.eventType.users[0]?.username;
  const profileUsername = hashedLink.eventType.users[0]?.profiles[0]?.username;

  if (hashedLink.eventType.team) {
    if (hostOrg && hashedLink.eventType.team.parentId !== hostOrg.id) {
      return notFound;
    }
    name = hashedLink.eventType.team.slug || "";
    hideBranding = shouldHideBrandingForTeamEvent({
      eventTypeId: hashedLink.eventTypeId,
      team: hashedLink.eventType.team,
    });
  } else {
    if (!username) {
      return notFound;
    }

    // Get just the origin and searchString from the redirect to ensure that we don't redirect to a URL that exposes the real path to book the user for any other events \
    // This is important for a private booking link
    // e.g. http://app.cal.com/d/sgdthj8mu4nsLNTYi3fW2p/demo -> should redirect to -> http://acme.cal.com/d/sgdthj8mu4nsLNTYi3fW2p/demo and not to http://acme.cal.com/john/demo(which exposes the real path to book the user for any other events)
    const redirectWithOriginAndSearchString = await getRedirectWithOriginAndSearchString({
      slugs: [username],
      redirectType: RedirectType.User,
      query: omitRouteParams(context.query, context.params),
      hostOrgId: hostOrg?.id ?? null,
    });

    if (redirectWithOriginAndSearchString) {
      return {
        redirect: {
          permanent: false,
          // App Router doesn't have access to the current path directly, so we build it manually
          destination: `${redirectWithOriginAndSearchString.origin ?? ""}/d/${link}/${slug}${
            redirectWithOriginAndSearchString.searchString
          }`,
        },
      };
    }

    // Checked after the redirect lookup: a user who moved out of the host org has no profile there
    // but still has a redirect from it.
    if (hostOrg) {
      const hostProfile = hashedLink.eventType.users[0]?.profiles.find(
        (profile) => profile.organizationId === hostOrg.id
      );
      if (!hostProfile) {
        return notFound;
      }
      name = hostProfile.username;
    } else {
      name = profileUsername || username;
    }

    const userRepo = new UserRepository(prisma);
    const [user] = await userRepo.findUsersByUsername({
      usernameList: [name],
      orgSlug,
    });

    if (!user) {
      return notFound;
    }

    hideBranding = shouldHideBrandingForUserEvent({
      eventTypeId: hashedLink.eventTypeId,
      owner: user,
    });
  }

  let booking: GetBookingType | null = null;
  if (rescheduleUid) {
    booking = await getBookingForReschedule(`${rescheduleUid}`, session?.user?.id);
  }

  const isTeamEvent = !!hashedLink.eventType?.team?.id;

  const eventData = await EventRepository.getPublicEvent(
    {
      username: name,
      eventSlug: slug,
      isTeamEvent,
      org: orgSlug,
      fromRedirectOfNonOrgLink: context.query.orgRedirection === "true",
    },
    session?.user?.id
  );

  if (!eventData) {
    return notFound;
  }

  const useApiV2 = false;

  return {
    props: {
      useApiV2,
      eventData,
      entity: eventData.entity,
      duration: getMultipleDurationValue(
        eventData.metadata?.multipleDuration,
        queryDuration,
        eventData.length
      ),
      durationConfig: eventData.metadata?.multipleDuration ?? [],
      booking,
      user: name,
      slug,
      isBrandingHidden: hideBranding,
      // Sending the team event from the server, because this template file
      // is reused for both team and user events.
      isTeamEvent,
      hashedLink: hashedLink?.link,
    },
  };
}

const paramsSchema = z.object({ link: z.string(), slug: z.string().transform((s) => slugify(s)) });

// Booker page fetches a tiny bit of data server side, to determine early
// whether the page should show an away state or dynamic booking not allowed.
export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  return await getUserPageProps(context);
};
