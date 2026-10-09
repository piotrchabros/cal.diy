import { ErrorWithCode } from "@calcom/lib/errors";
import type {
  IBookingNotetakerRepository,
  NotetakerBookingContext,
} from "../repositories/interfaces/IBookingNotetakerRepository";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Deliberately no membership, permission or team dependency: team and
// organization admins are not hosts and must not gain access through a role.
export interface INotetakerAccessServiceDeps {
  bookingNotetakerRepository: IBookingNotetakerRepository;
}

export type NotetakerViewerRole = "HOST" | "ATTENDEE";

export class NotetakerAccessService {
  constructor(private readonly deps: INotetakerAccessServiceDeps) {}

  async resolveViewerRole(params: {
    bookingUid: string;
    userId: number;
  }): Promise<{ role: NotetakerViewerRole; booking: NotetakerBookingContext }> {
    const { bookingUid, userId } = params;

    // Resolved before any authorization check so an unknown uid is NotFound for every caller.
    const booking = await this.getBookingOrThrow(bookingUid);

    if (this.isHost(userId, booking)) return { role: "HOST", booking };

    // Read on every call rather than cached, so revoking the grant takes effect immediately.
    const sharingGrant = await this.deps.bookingNotetakerRepository.findSharingGrant(booking.id);
    if (!sharingGrant) {
      throw ErrorWithCode.Factory.Forbidden(
        "You do not have access to the notetaker results of this booking"
      );
    }

    const verifiedEmails = await this.deps.bookingNotetakerRepository.findVerifiedEmailsByUserId(userId);
    const attendeeEmails = new Set(booking.attendeeEmails.map(normalizeEmail));
    const isAttendee = verifiedEmails.some((email) => attendeeEmails.has(normalizeEmail(email)));
    if (isAttendee) return { role: "ATTENDEE", booking };

    throw ErrorWithCode.Factory.Forbidden("You do not have access to the notetaker results of this booking");
  }

  async assertHost(params: { bookingUid: string; userId: number }): Promise<NotetakerBookingContext> {
    const { bookingUid, userId } = params;

    const booking = await this.getBookingOrThrow(bookingUid);

    if (!this.isHost(userId, booking)) {
      throw ErrorWithCode.Factory.Forbidden("Only a host of this booking can perform this action");
    }

    return booking;
  }

  private async getBookingOrThrow(bookingUid: string): Promise<NotetakerBookingContext> {
    const booking = await this.deps.bookingNotetakerRepository.findByBookingUidIncludeBooking(bookingUid);
    if (!booking) throw ErrorWithCode.Factory.NotFound(`Booking ${bookingUid} not found`);
    return booking;
  }

  private isHost(userId: number, booking: NotetakerBookingContext): boolean {
    // booking.userId rather than booking.organizer, which may be null.
    if (booking.userId === userId) return true;

    // Being listed on the event type is not enough: a host counts only when
    // their own listed email is an attendee of this particular booking.
    const attendeeEmails = new Set(booking.attendeeEmails.map(normalizeEmail));
    return booking.eventTypeHosts.some(
      (host) => host.userId === userId && attendeeEmails.has(normalizeEmail(host.email))
    );
  }
}
