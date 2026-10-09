import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import type {
  INotetakerCalendarGuestGateway,
  NotetakerCalendarEventRef,
} from "../calendar/INotetakerCalendarGuestGateway";
import type { NotetakerConfig } from "../lib/config";
import type { IBookingNotetakerRepository } from "../repositories/interfaces/IBookingNotetakerRepository";

const GOOGLE_CALENDAR_REFERENCE_TYPE = "google_calendar";
const TIMEOUT_MESSAGE = "calendar invite timed out";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export type NotetakerCalendarInviteOutcome =
  | "INVITED"
  | "ALREADY_INVITED"
  | "NOT_CONFIGURED"
  | "NOT_GOOGLE_MEET"
  | "NO_CALENDAR_EVENT"
  | "NOT_THE_MEETING_EVENT"
  | "CREDENTIAL_UNAVAILABLE"
  | "FAILED";

export const NOTETAKER_CALENDAR_INVITE_TIMEOUT_MS = 8_000;

export interface INotetakerCalendarInviteServiceDeps {
  bookingNotetakerRepository: Pick<IBookingNotetakerRepository, "findReferencesByBookingIdAndType">;
  calendarGuestGateway: INotetakerCalendarGuestGateway;
  config: NotetakerConfig;
  logger: ISimpleLogger;
}

export class NotetakerCalendarInviteService {
  constructor(private readonly deps: INotetakerCalendarInviteServiceDeps) {}

  /** Never rejects. Resolves within NOTETAKER_CALENDAR_INVITE_TIMEOUT_MS. */
  async ensureBotInvited(params: {
    bookingId: number;
    sessionId: string;
    platform: NotetakerPlatformDto;
    meetingUrl: string;
  }): Promise<NotetakerCalendarInviteOutcome> {
    const guestEmail = this.deps.config.googleAccountEmail;
    if (guestEmail === null || this.deps.config.botProvider !== "SELF_HOSTED") return "NOT_CONFIGURED";
    if (params.platform !== "GOOGLE_MEET") return "NOT_GOOGLE_MEET";

    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: NotetakerCalendarInviteOutcome;
    let failureMessage: string | undefined;
    // The join request must not wait on Google; a call left behind by the timer keeps running in the background.
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), NOTETAKER_CALENDAR_INVITE_TIMEOUT_MS);
      });
      outcome = await Promise.race([
        this.inviteThroughReferences(params.bookingId, params.meetingUrl, guestEmail),
        timeout,
      ]);
    } catch (error) {
      outcome = "FAILED";
      failureMessage = getErrorMessage(error);
    } finally {
      clearTimeout(timer);
    }

    this.log(params.bookingId, params.sessionId, outcome, failureMessage);
    return outcome;
  }

  private async inviteThroughReferences(
    bookingId: number,
    meetingUrl: string,
    guestEmail: string
  ): Promise<NotetakerCalendarInviteOutcome> {
    const references = await this.deps.bookingNotetakerRepository.findReferencesByBookingIdAndType({
      bookingId,
      type: GOOGLE_CALENDAR_REFERENCE_TYPE,
    });
    const withEvent = references.filter((reference) => reference.uid.length > 0);
    if (withEvent.length === 0) return "NO_CALENDAR_EVENT";

    const events: NotetakerCalendarEventRef[] = [];
    for (const reference of withEvent) {
      const { credentialId } = reference;
      if (credentialId === null || credentialId <= 0) continue;
      events.push({
        credentialId,
        eventId: reference.uid,
        calendarId: reference.externalCalendarId,
      });
    }
    if (events.length === 0) return "CREDENTIAL_UNAVAILABLE";

    let remembered: "NOT_THE_MEETING_EVENT" | "CREDENTIAL_UNAVAILABLE" = "CREDENTIAL_UNAVAILABLE";
    for (const event of events) {
      const result = await this.deps.calendarGuestGateway.ensureGuest({ event, guestEmail, meetingUrl });
      if (result === "ADDED") return "INVITED";
      if (result === "ALREADY_PRESENT") return "ALREADY_INVITED";
      remembered = result;
    }
    return remembered;
  }

  private log(
    bookingId: number,
    sessionId: string,
    outcome: NotetakerCalendarInviteOutcome,
    failureMessage: string | undefined
  ): void {
    const warning = "Notetaker calendar invite did not succeed; the notetaker will ask to join";
    switch (outcome) {
      case "CREDENTIAL_UNAVAILABLE":
        this.deps.logger.warn(warning, { bookingId, sessionId, outcome });
        return;
      case "FAILED":
        this.deps.logger.warn(warning, { bookingId, sessionId, outcome, message: failureMessage });
        return;
      default:
        this.deps.logger.info("Notetaker calendar invite finished", { bookingId, sessionId, outcome });
    }
  }
}
