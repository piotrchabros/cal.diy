import type { WebhookSubscriber } from "@calcom/features/webhooks/lib/dto/types";
import type {
  EventPayloadType,
  NotetakerMeetingTranscriptPayload,
} from "@calcom/features/webhooks/lib/sendPayload";
import type { NotetakerMeetingBookingPayload } from "../lib/meetingBookingPayload";

export interface INotetakerTranscriptWebhookGateway {
  /** The user's own webhooks, plus opted-in webhooks of memberSharingTeamIds; each webhook once. */
  findSubscribers(params: { userId: number; memberSharingTeamIds?: number[] }): Promise<WebhookSubscriber[]>;
  buildBookingPayload(params: {
    bookingId: number;
    fallbackVideoCallUrl: string | null;
  }): Promise<EventPayloadType | null>;
  /** For a booking without an event type (ad hoc or calendar auto-join). */
  buildMeetingPayload(params: {
    bookingId: number;
    fallbackVideoCallUrl: string | null;
  }): Promise<NotetakerMeetingBookingPayload | null>;
  deliver(params: {
    subscribers: WebhookSubscriber[];
    createdAt: string;
    payload: EventPayloadType | NotetakerMeetingTranscriptPayload;
  }): Promise<{ attempted: number; failed: number }>;
}
