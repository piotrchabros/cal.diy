import type { BookingRepository } from "@calcom/features/bookings/repositories/BookingRepository";
import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { WebhookSubscriber } from "@calcom/features/webhooks/lib/dto/types";
import type {
  EventPayloadType,
  NotetakerMeetingTranscriptPayload,
} from "@calcom/features/webhooks/lib/sendPayload";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import {
  buildNotetakerMeetingBookingPayload,
  type NotetakerMeetingBookingPayload,
} from "../lib/meetingBookingPayload";
import type { IBookingNotetakerRepository } from "../repositories/interfaces/IBookingNotetakerRepository";
import type { INotetakerTranscriptWebhookGateway } from "./INotetakerTranscriptWebhookGateway";

function readVideoCallUrl(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).videoCallUrl;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface ICalcomNotetakerTranscriptWebhookGatewayDependencies {
  bookingRepository: Pick<BookingRepository, "getBookingForCalEventBuilder">;
  bookingNotetakerRepository: Pick<IBookingNotetakerRepository, "findMeetingForWebhook">;
  logger: ISimpleLogger;
}

// The booking, calendar event and metadata fields mirror the BOOKING_CREATED payload built in
// RegularBookingService so receivers can reuse one booking parser for every trigger.
export class CalcomNotetakerTranscriptWebhookGateway implements INotetakerTranscriptWebhookGateway {
  constructor(public readonly dependencies: ICalcomNotetakerTranscriptWebhookGatewayDependencies) {}

  async findSubscribers(params: {
    userId: number;
    memberSharingTeamIds?: number[];
  }): Promise<WebhookSubscriber[]> {
    const { default: getWebhooks } = await import("@calcom/features/webhooks/lib/getWebhooks");
    return getWebhooks({
      userId: params.userId,
      eventTypeId: null,
      teamId: null,
      orgId: null,
      oAuthClientId: null,
      memberSharingTeamIds: params.memberSharingTeamIds,
      triggerEvent: WebhookTriggerEvents.RECORDING_TRANSCRIPTION_GENERATED,
    });
  }

  async buildBookingPayload(params: {
    bookingId: number;
    fallbackVideoCallUrl: string | null;
  }): Promise<EventPayloadType | null> {
    const { bookingRepository, logger } = this.dependencies;
    const { bookingId, fallbackVideoCallUrl } = params;

    try {
      const booking = await bookingRepository.getBookingForCalEventBuilder(bookingId);
      if (!booking || !booking.eventType) {
        logger.warn("Notetaker transcript webhook skipped: booking has no event type", { bookingId });
        return null;
      }

      const [{ CalendarEventBuilder }, { getVideoCallUrlFromCalEvent }] = await Promise.all([
        import("@calcom/features/CalendarEventBuilder"),
        import("@calcom/lib/CalEventParser"),
      ]);
      const evt = (await CalendarEventBuilder.fromBooking(booking)).build();

      const videoCallUrl =
        getVideoCallUrlFromCalEvent(evt) || readVideoCallUrl(booking.metadata) || fallbackVideoCallUrl;
      const metadata = videoCallUrl ? { videoCallUrl } : undefined;

      return {
        ...evt,
        bookingId: booking.id,
        eventTypeId: booking.eventTypeId,
        status: booking.status,
        metadata,
        location: metadata?.videoCallUrl || evt.location,
        source: "booking",
      } as EventPayloadType;
    } catch (error) {
      logger.error("Notetaker transcript webhook booking payload failed", {
        bookingId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async buildMeetingPayload(params: {
    bookingId: number;
    fallbackVideoCallUrl: string | null;
  }): Promise<NotetakerMeetingBookingPayload | null> {
    const { bookingNotetakerRepository, logger } = this.dependencies;
    const { bookingId, fallbackVideoCallUrl } = params;

    try {
      const meeting = await bookingNotetakerRepository.findMeetingForWebhook(bookingId);
      if (!meeting || !meeting.owner) {
        logger.warn("Notetaker transcript webhook skipped: meeting has no owner", { bookingId });
        return null;
      }
      return buildNotetakerMeetingBookingPayload({
        booking: meeting.booking,
        owner: meeting.owner,
        contacts: meeting.contacts,
        fallbackVideoCallUrl,
      });
    } catch (error) {
      logger.error("Notetaker transcript webhook meeting payload failed", {
        bookingId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async deliver(params: {
    subscribers: WebhookSubscriber[];
    createdAt: string;
    payload: EventPayloadType | NotetakerMeetingTranscriptPayload;
  }): Promise<{ attempted: number; failed: number }> {
    const { logger } = this.dependencies;
    const { default: sendOrSchedulePayload } = await import(
      "@calcom/features/webhooks/lib/sendOrSchedulePayload"
    );

    let failed = 0;
    for (const subscriber of params.subscribers) {
      try {
        await sendOrSchedulePayload(
          subscriber.secret,
          WebhookTriggerEvents.RECORDING_TRANSCRIPTION_GENERATED,
          params.createdAt,
          subscriber,
          params.payload
        );
      } catch (error) {
        failed += 1;
        logger.error("Notetaker transcript webhook delivery failed", {
          webhookId: subscriber.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { attempted: params.subscribers.length, failed };
  }
}
