import type { NotetakerBookingSource } from "@calcom/lib/dto/NotetakerTranscriptWebhookDto";
import { readAdHocBookingMetadata } from "./adHocMeeting";
import { isCalendarMeetingBookingMetadata } from "./calendarMeeting";

export type { NotetakerBookingSource };

export type NotetakerMeetingWebhookPerson = {
  name: string;
  email: string;
  timeZone: string;
  language: { locale: string };
};

export type NotetakerMeetingBookingPayload = {
  type: "notetaker_meeting";
  uid: string;
  bookingId: number;
  eventTypeId: null;
  status: string;
  title: string;
  startTime: string;
  endTime: string;
  organizer: NotetakerMeetingWebhookPerson;
  attendees: NotetakerMeetingWebhookPerson[];
  location: string | null;
  metadata: { videoCallUrl: string } | undefined;
  source: Exclude<NotetakerBookingSource, "booking">;
};

export type BuildNotetakerMeetingBookingPayloadInput = {
  booking: {
    id: number;
    uid: string;
    title: string;
    startTime: Date;
    endTime: Date;
    status: string;
    location: string | null;
    metadata: unknown;
  };
  owner: { name: string | null; email: string; timeZone: string; locale: string | null };
  contacts: { email: string; name: string | null }[];
  fallbackVideoCallUrl: string | null;
};

const DEFAULT_LOCALE = "en";

export function resolveNotetakerBookingSource(metadata: unknown): NotetakerBookingSource {
  if (readAdHocBookingMetadata(metadata).isAdHoc) return "ad_hoc";
  if (isCalendarMeetingBookingMetadata(metadata)) return "calendar_auto_join";
  return "booking";
}

export function buildNotetakerMeetingBookingPayload(
  input: BuildNotetakerMeetingBookingPayloadInput
): NotetakerMeetingBookingPayload {
  const { booking, owner, contacts, fallbackVideoCallUrl } = input;
  const language = { locale: owner.locale ?? DEFAULT_LOCALE };
  const videoCallUrl = booking.location ?? fallbackVideoCallUrl;
  const resolvedSource = resolveNotetakerBookingSource(booking.metadata);

  return {
    type: "notetaker_meeting",
    uid: booking.uid,
    bookingId: booking.id,
    eventTypeId: null,
    status: booking.status,
    title: booking.title,
    startTime: booking.startTime.toISOString(),
    endTime: booking.endTime.toISOString(),
    organizer: {
      name: owner.name ?? owner.email,
      email: owner.email,
      timeZone: owner.timeZone,
      language,
    },
    attendees: contacts.map((contact) => ({
      name: contact.name ?? "",
      email: contact.email,
      timeZone: owner.timeZone,
      language,
    })),
    location: videoCallUrl,
    metadata: videoCallUrl ? { videoCallUrl } : undefined,
    // An event-type-less booking is never a regular booking, so unmarked metadata is treated as ad hoc.
    source: resolvedSource === "booking" ? "ad_hoc" : resolvedSource,
  };
}
