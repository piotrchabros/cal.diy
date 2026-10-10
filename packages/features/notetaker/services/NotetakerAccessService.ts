import { ErrorWithCode } from "@calcom/lib/errors";
import type { INotetakerMembershipLookup } from "../lib/membershipLookup";
import type {
  IBookingNotetakerRepository,
  NotetakerBookingContext,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type { IEventTypeNotetakerSettingsRepository } from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";
import type { INotetakerSessionRepository } from "../repositories/interfaces/INotetakerSessionRepository";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const NOTETAKER_RESULTS_ACCESS_DENIED_MESSAGE =
  "You do not have access to the notetaker results of this booking";

// Membership grants read access in exactly one case: a colleague under the event
// type's sharing mode, for a session whose participants were told about it.
// A team or organization role never makes a host.
export interface INotetakerAccessServiceDeps {
  bookingNotetakerRepository: IBookingNotetakerRepository;
  sessionRepository: Pick<INotetakerSessionRepository, "findLatestWithTranscriptByBookingId">;
  eventTypeNotetakerSettingsRepository: Pick<IEventTypeNotetakerSettingsRepository, "hasSharingMember">;
  membershipLookup: Pick<INotetakerMembershipLookup, "isAcceptedMember">;
}

export type NotetakerViewerRole = "HOST" | "ATTENDEE" | "SHARED_VIEWER";

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
    if (sharingGrant) {
      const verifiedEmails = await this.deps.bookingNotetakerRepository.findVerifiedEmailsByUserId(userId);
      const attendeeEmails = new Set(booking.attendeeEmails.map(normalizeEmail));
      const isAttendee = verifiedEmails.some((email) => attendeeEmails.has(normalizeEmail(email)));
      if (isAttendee) return { role: "ATTENDEE", booking };
    }

    if (await this.isSharedViewer(userId, booking)) return { role: "SHARED_VIEWER", booking };

    throw ErrorWithCode.Factory.Forbidden(NOTETAKER_RESULTS_ACCESS_DENIED_MESSAGE);
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

  private async isSharedViewer(userId: number, booking: NotetakerBookingContext): Promise<boolean> {
    const { eventTypeId, teamId, sharingMode } = booking;
    if (eventTypeId === null || teamId === null || sharingMode === "HOSTS_ONLY") return false;

    // Only the latest session that has a transcript counts: the results a viewer would read come
    // from it, so an earlier disclosed session must not open a later one recorded without the notice.
    const results = await this.deps.sessionRepository.findLatestWithTranscriptByBookingId(booking.id);
    if (!results) return false;
    if (!results.session.colleagueSharingDisclosed || results.session.resultsDeletedAt !== null) return false;

    // Membership is read on every call, so leaving the team ends the access immediately.
    if (sharingMode === "TEAM") return this.deps.membershipLookup.isAcceptedMember({ userId, teamId });

    const isListed = await this.deps.eventTypeNotetakerSettingsRepository.hasSharingMember({
      eventTypeId,
      userId,
    });
    if (!isListed) return false;

    // The list can name anyone in the organization, so a listed person is checked against
    // the organization when there is one. Being listed alone is not enough after they leave.
    return this.deps.membershipLookup.isAcceptedMember({
      userId,
      teamId: booking.organizationId ?? teamId,
    });
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
