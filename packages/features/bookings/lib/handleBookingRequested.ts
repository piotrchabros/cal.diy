import { sendAttendeeRequestEmailAndSMS, sendOrganizerRequestEmail } from "@calcom/emails/email-manager";
import { getWebhookPayloadForBooking } from "@calcom/features/bookings/lib/getWebhookPayloadForBooking";
import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { MembershipRepositoryNotetakerLookup } from "@calcom/features/notetaker/lib/MembershipRepositoryNotetakerLookup";
import { resolveMemberSharingTeamIds } from "@calcom/features/notetaker/lib/webhookSharingTeam";
import getWebhooks from "@calcom/features/webhooks/lib/getWebhooks";
import sendPayload from "@calcom/features/webhooks/lib/sendOrSchedulePayload";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import prisma from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import type { EventTypeMetadata } from "@calcom/prisma/zod-utils";
import type { CalendarEvent } from "@calcom/types/Calendar";

const log = logger.getSubLogger({ prefix: ["[handleBookingRequested] book:user"] });

/**
 * Supposed to do whatever is needed when a booking is requested.
 */
export async function handleBookingRequested(args: {
  evt: CalendarEvent;
  booking: {
    smsReminderNumber: string | null;
    eventType: {
      currency: string;
      description: string | null;
      id: number;
      length: number;
      price: number;
      requiresConfirmation: boolean;
      title: string;
      metadata: Prisma.JsonValue;
    } | null;
    eventTypeId: number | null;
    userId: number | null;
    id: number;
  };
}) {
  const { evt, booking } = args;

  log.debug("Emails: Sending booking requested emails");

  await sendOrganizerRequestEmail({ ...evt }, booking?.eventType?.metadata as EventTypeMetadata);
  await sendAttendeeRequestEmailAndSMS(
    { ...evt },
    evt.attendees[0],
    booking?.eventType?.metadata as EventTypeMetadata
  );

  let memberSharingTeamIds: number[] = [];
  try {
    const sharingBooking = await prisma.booking.findUnique({
      where: { id: booking.id },
      select: {
        userId: true,
        metadata: true,
        eventType: {
          select: {
            teamId: true,
            userId: true,
            team: { select: { id: true, name: true, parentId: true } },
            notetakerSettings: {
              select: { sharingMode: true, sharingTeam: { select: { id: true, name: true } } },
            },
          },
        },
      },
    });
    if (sharingBooking) {
      memberSharingTeamIds = await resolveMemberSharingTeamIds(
        {
          ownerUserId: sharingBooking.userId,
          eventType: sharingBooking.eventType,
          bookingMetadata: sharingBooking.metadata,
        },
        new MembershipRepositoryNotetakerLookup(new MembershipRepository(prisma))
      );
    }
  } catch {
    log.error(`Failed to resolve member sharing team ids, bookingId: ${booking.id}`);
  }

  try {
    const subscribersBookingRequested = await getWebhooks({
      userId: booking.userId,
      eventTypeId: booking.eventTypeId,
      triggerEvent: WebhookTriggerEvents.BOOKING_REQUESTED,
      teamId: null,
      orgId: undefined,
      memberSharingTeamIds,
    });

    const webhookPayload = getWebhookPayloadForBooking({
      booking,
      evt,
    });

    const promises = subscribersBookingRequested.map((sub) =>
      sendPayload(
        sub.secret,
        WebhookTriggerEvents.BOOKING_REQUESTED,
        new Date().toISOString(),
        sub,
        webhookPayload
      ).catch((e) => {
        log.error(
          `Error executing webhook for event: ${WebhookTriggerEvents.BOOKING_REQUESTED}, URL: ${sub.subscriberUrl}, bookingId: ${evt.bookingId}, bookingUid: ${evt.uid}`,
          safeStringify(e)
        );
      })
    );
    await Promise.all(promises);
  } catch (error) {
    // Silently fail
    log.error("Error in handleBookingRequested", safeStringify(error));
  }
}
