import { WEBAPP_URL } from "@calcom/lib/constants";
import type { CalendarEvent, Person } from "@calcom/types/Calendar";
import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import AwaitingPaymentSMS from "../attendee/awaiting-payment-sms";
import EventCancelledSMS from "../attendee/event-cancelled-sms";
import EventLocationChangedSMS from "../attendee/event-location-changed-sms";
import EventRequestSMS from "../attendee/event-request-sms";
import EventRequestToRescheduleSMS from "../attendee/event-request-to-reschedule-sms";
import EventRescheduledSMS from "../attendee/event-rescheduled-sms";
import EventSuccessfullyScheduledSMS from "../attendee/event-scheduled-sms";

vi.mock("@calcom/lib/smsLockState");

const ORG_URL = "https://org.example.com";

// Echo the url interpolation value so the assertion sees the link the SMS would send.
const translate = ((_key: string, options?: { url?: string }) => options?.url ?? "") as unknown as TFunction;

const attendee: Person = {
  name: "Guest",
  email: "guest@example.com",
  phoneNumber: "+48123456789",
  timeZone: "UTC",
  language: { translate, locale: "en" },
};

const buildEvent = (bookerUrl?: string): CalendarEvent => ({
  type: "Intro",
  title: "Intro call",
  startTime: "2026-11-10T10:00:00.000Z",
  endTime: "2026-11-10T10:30:00.000Z",
  organizer: { ...attendee, id: 1, name: "Host", email: "host@example.com" },
  attendees: [attendee],
  uid: "booking-uid",
  bookerUrl,
});

const smsClasses = [
  AwaitingPaymentSMS,
  EventCancelledSMS,
  EventLocationChangedSMS,
  EventRequestSMS,
  EventRequestToRescheduleSMS,
  EventRescheduledSMS,
  EventSuccessfullyScheduledSMS,
];

describe("attendee SMS booking links", () => {
  it.each(
    smsClasses.map((SmsClass) => [SmsClass.name, SmsClass] as const)
  )("%s links to the booking on bookerUrl", (_name, SmsClass) => {
    expect(new SmsClass(buildEvent(ORG_URL)).getMessage(attendee)).toContain(
      `${ORG_URL}/booking/booking-uid`
    );
  });

  it.each(
    smsClasses.map((SmsClass) => [SmsClass.name, SmsClass] as const)
  )("%s falls back to WEBAPP_URL", (_name, SmsClass) => {
    expect(new SmsClass(buildEvent()).getMessage(attendee)).toContain(`${WEBAPP_URL}/booking/booking-uid`);
  });
});
