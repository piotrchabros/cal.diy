export type NotetakerCalendarMeetingParticipantRecord = {
  userId: number;
  selectedCalendarId: string;
  externalEventId: string;
  removedAt: Date | null;
};

export type NotetakerCalendarMeetingRecord = {
  id: string;
  bookingId: number;
  bookingUid: string;
  ownerUserId: number;
  meetingKey: string;
  startTime: Date;
  endTime: Date;
  /** A NotetakerSession of any status exists for the booking. */
  hasSession: boolean;
  participants: NotetakerCalendarMeetingParticipantRecord[];
};

export type NotetakerCalDiyBookingMatchRecord = {
  bookingId: number;
  hostUserId: number | null;
  hasNotetakerChoice: boolean;
};

export type NotetakerCalendarMeetingOwnerInput = {
  userId: number;
  email: string;
  name: string;
  timeZone: string;
  selectedCalendarId: string;
  externalEventId: string;
};

export interface INotetakerCalendarMeetingRepository {
  findByParticipantEvent(params: {
    selectedCalendarId: string;
    externalEventId: string;
  }): Promise<NotetakerCalendarMeetingRecord | null>;
  findByKey(params: { meetingKey: string; startTime: Date }): Promise<NotetakerCalendarMeetingRecord | null>;
  /** Meetings where the calendar has a non-removed participant and startTime is in [from, to). */
  findActiveByCalendarInRange(params: {
    selectedCalendarId: string;
    from: Date;
    to: Date;
  }): Promise<NotetakerCalendarMeetingRecord[]>;
  /**
   * Creates booking, notetaker choice, activity, meeting and first participant atomically.
   * "CONFLICT" when another meeting already holds (meetingKey, startTime).
   */
  createWithBooking(params: {
    bookingUid: string;
    title: string;
    meetingUrl: string;
    meetingKey: string;
    startTime: Date;
    endTime: Date;
    iCalUID: string | null;
    metadata: Record<string, string>;
    owner: NotetakerCalendarMeetingOwnerInput;
    seenAt: Date;
  }): Promise<NotetakerCalendarMeetingRecord | "CONFLICT">;
  /** Revives a removed participant and adds an Attendee row (unless the user owns the booking or the email is already listed). */
  upsertParticipant(params: {
    meetingId: string;
    bookingId: number;
    userId: number;
    email: string;
    name: string;
    timeZone: string;
    selectedCalendarId: string;
    externalEventId: string;
    seenAt: Date;
  }): Promise<void>;
  markParticipantRemoved(params: { meetingId: string; userId: number; at: Date }): Promise<void>;
  touchParticipant(params: { meetingId: string; userId: number; seenAt: Date }): Promise<void>;
  reschedule(params: {
    meetingId: string;
    bookingId: number;
    startTime: Date;
    endTime: Date;
    meetingUrl: string;
    meetingKey: string;
  }): Promise<"OK" | "CONFLICT">;
  transferOwner(params: { meetingId: string; bookingId: number; userId: number }): Promise<void>;
  /** Cancels the booking and disables its notetaker choice. */
  cancel(params: { meetingId: string; bookingId: number }): Promise<void>;
  isParticipant(params: { bookingId: number; userId: number }): Promise<boolean>;
  countCreatedByOwnerSince(params: { userId: number; since: Date }): Promise<number>;
  /**
   * A live Cal.diy booking matching the calendar event by iCalUID or booking reference uid.
   * Bookings that are calendar auto-join meetings themselves are excluded.
   */
  findCalDiyBookingForEvent(params: {
    iCalUID: string | null;
    externalEventId: string;
  }): Promise<NotetakerCalDiyBookingMatchRecord | null>;
  /** Creates the choice only when the booking has none; true when it created it. */
  enableChoiceForCalendarAutoJoin(params: { bookingId: number }): Promise<boolean>;
}
