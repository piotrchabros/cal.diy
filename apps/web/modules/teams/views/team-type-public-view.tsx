"use client";

import { getBookerWrapperClasses } from "@calcom/features/bookings/Booker/utils/getBookerWrapperClasses";
import { BookerWebWrapper as Booker } from "@calcom/web/modules/bookings/components/BookerWebWrapper";
import { getMultipleDurationValue } from "@calcom/web/modules/users/views/users-type-public-view";
import BookingPageErrorBoundary from "@components/error/BookingPageErrorBoundary";
import type { inferSSRProps } from "@lib/types/inferSSRProps";
import type { getServerSideProps } from "@server/lib/team/[slug]/[type]/getServerSideProps";
import type { EmbedProps } from "app/WithEmbedSSR";
import { useSearchParams } from "next/navigation";

export type PageProps = inferSSRProps<typeof getServerSideProps> & EmbedProps;

function Type({ slug, user, isEmbed, booking, isBrandingHidden, eventData, orgBannerUrl }: PageProps) {
  const searchParams = useSearchParams();

  return (
    <BookingPageErrorBoundary>
      <main className={getBookerWrapperClasses({ isEmbed: !!isEmbed })}>
        <Booker
          username={user}
          eventSlug={slug}
          isTeamEvent
          // Team slots would otherwise go to API v2, which isn't deployed.
          useApiV2={false}
          bookingData={booking ?? undefined}
          hideBranding={isBrandingHidden}
          eventData={eventData}
          entity={{ ...eventData.entity, eventTypeId: eventData.id }}
          durationConfig={eventData.metadata?.multipleDuration}
          orgBannerUrl={orgBannerUrl}
          duration={getMultipleDurationValue(
            eventData.metadata?.multipleDuration,
            searchParams?.get("duration") ?? undefined,
            eventData.length
          )}
        />
      </main>
    </BookingPageErrorBoundary>
  );
}

export default Type;
