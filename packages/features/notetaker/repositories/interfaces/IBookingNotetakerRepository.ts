import type { NotetakerChoiceSourceDto } from "@calcom/lib/dto/NotetakerStateDto";

export type NotetakerBookingStatus = "CANCELLED" | "ACCEPTED" | "REJECTED" | "PENDING" | "AWAITING_HOST";

export type BookingNotetakerRecord = {
  bookingId: number;
  enabled: boolean;
  pendingDispatch: boolean;
  source: NotetakerChoiceSourceDto;
  appliedToSeries: boolean;
  rejoinBlocked: boolean;
  setByUserId: number | null;
  setAt: Date;
  attendeesNotifiedAt: Date | null;
  notifiedAttendeeEmails: string[];
};

export type NotetakerSharingGrantRecord = {
  bookingId: number;
  grantedByUserId: number | null;
  grantedAt: Date;
};

export type NotetakerAttendeeRecord = {
  email: string;
  name: string;
  locale: string | null;
  timeZone: string;
};

export type NotetakerBookingContext = {
  id: number;
  uid: string;
  userId: number | null;
  status: NotetakerBookingStatus;
  startTime: Date;
  endTime: Date;
  title: string;
  location: string | null;
  metadata: unknown;
  recurringEventId: string | null;
  eventTypeId: number | null;
  attendeeEmails: string[];
  /** Non-deleted references only. */
  references: { type: string; meetingUrl: string | null }[];
  /** EventType.hosts and EventType.users merged. */
  eventTypeHosts: { userId: number; email: string }[];
  organizer: { id: number; name: string | null; email: string; locale: string | null } | null;
  choice: BookingNotetakerRecord | null;
};

export interface IBookingNotetakerRepository {
  findByBookingId(bookingId: number): Promise<BookingNotetakerRecord | null>;
  findByBookingUidIncludeBooking(bookingUid: string): Promise<NotetakerBookingContext | null>;
  findByBookingIdIncludeBooking(bookingId: number): Promise<NotetakerBookingContext | null>;
  upsert(data: {
    bookingId: number;
    enabled: boolean;
    pendingDispatch: boolean;
    source: NotetakerChoiceSourceDto;
    appliedToSeries: boolean;
    setByUserId: number | null;
    setAt: Date;
    notifiedAttendeeEmails?: string[];
  }): Promise<BookingNotetakerRecord>;
  /** Sets enabled = false and pendingDispatch = false. */
  disable(bookingId: number): Promise<void>;
  /**
   * Atomic compare-and-swap: updateMany where bookingId matches AND pendingDispatch = true.
   * Resolves true when this call won the swap.
   */
  clearPendingDispatch(bookingId: number): Promise<boolean>;
  setPendingDispatch(bookingId: number, pendingDispatch: boolean): Promise<void>;
  setRejoinBlocked(bookingId: number, rejoinBlocked: boolean): Promise<void>;
  /** Ordered by booking.startTime ascending. */
  findEnabledIncludeBooking(params: {
    bookingStatuses: NotetakerBookingStatus[];
    startTimeLte: Date;
    endTimeGt?: Date;
    pendingDispatch?: boolean;
    limit: number;
  }): Promise<NotetakerBookingContext[]>;
  findByRecurringEventIdFromStartTime(params: {
    recurringEventId: string;
    startTimeGte: Date;
  }): Promise<
    { bookingId: number; bookingUid: string; startTime: Date; choice: BookingNotetakerRecord | null }[]
  >;
  appendNotifiedAttendeeEmails(bookingId: number, emails: string[], at: Date): Promise<void>;
  findNotifiedAttendeeEmailsByRecurringEventId(recurringEventId: string): Promise<string[]>;
  findSharingGrant(bookingId: number): Promise<NotetakerSharingGrantRecord | null>;
  createSharingGrant(data: {
    bookingId: number;
    grantedByUserId: number | null;
  }): Promise<NotetakerSharingGrantRecord>;
  deleteSharingGrant(bookingId: number): Promise<boolean>;
  /** Primary email plus SecondaryEmail rows with emailVerified set. */
  findVerifiedEmailsByUserId(userId: number): Promise<string[]>;
  /**
   * Atomic off-to-on. Creates the row with enabled = true and pendingDispatch = true, or flips a
   * row that has enabled = false AND rejoinBlocked = false. Resolves true only for the call that
   * made the change; false when the row is already enabled or is rejoin-blocked (nothing is
   * written). Never touches notifiedAttendeeEmails, attendeesNotifiedAt or rejoinBlocked.
   */
  enableIfDisabled(data: {
    bookingId: number;
    source: NotetakerChoiceSourceDto;
    appliedToSeries: boolean;
    setByUserId: number | null;
    setAt: Date;
  }): Promise<boolean>;
  /** The booking's current Attendee rows, ordered by id ascending. */
  findAttendeesByBookingId(bookingId: number): Promise<NotetakerAttendeeRecord[]>;
}
