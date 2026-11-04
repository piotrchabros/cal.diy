export type NotetakerMeetingContactSource = "MANUAL" | "CALENDAR";

export type NotetakerMeetingContactRecord = {
  email: string;
  name: string | null;
  source: NotetakerMeetingContactSource;
};

export interface INotetakerMeetingContactRepository {
  /** Ordered by createdAt asc, then email asc. */
  listByBookingId(bookingId: number): Promise<NotetakerMeetingContactRecord[]>;
  /**
   * Replaces the booking's contacts of one source and leaves the other source untouched.
   * Emails are unique per booking, so an email already stored with the other source keeps that
   * row (and its name) and is skipped here. Callers normalise emails before calling.
   */
  replaceForSource(params: {
    bookingId: number;
    source: NotetakerMeetingContactSource;
    contacts: { email: string; name: string | null }[];
  }): Promise<void>;
}
