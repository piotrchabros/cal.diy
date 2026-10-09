import {
  sendNotetakerAttendeeNoticeEmail,
  sendNotetakerResultsReadyEmail,
} from "@calcom/emails/notetaker-email-service";
import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { getTranslation } from "@calcom/i18n/server";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorWithCode } from "@calcom/lib/errors";
import { getNotetakerHostName } from "../lib/hostName";
import type { NotetakerSendNotificationPayload } from "../lib/tasker/types";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type {
  IBookingNotetakerRepository,
  NotetakerAttendeeRecord,
  NotetakerBookingContext,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type { INotetakerActivityRepository } from "../repositories/interfaces/INotetakerActivityRepository";
import type { INotetakerSessionRepository } from "../repositories/interfaces/INotetakerSessionRepository";
import type { INotetakerSummaryRepository } from "../repositories/interfaces/INotetakerSummaryRepository";
import type { INotetakerTranscriptRepository } from "../repositories/interfaces/INotetakerTranscriptRepository";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface INotetakerNotificationServiceDeps {
  bookingNotetakerRepository: IBookingNotetakerRepository;
  activityRepository: INotetakerActivityRepository;
  sessionRepository: INotetakerSessionRepository;
  transcriptRepository: INotetakerTranscriptRepository;
  summaryRepository: INotetakerSummaryRepository;
  userRepository: INotetakerUserLookup;
  logger: ISimpleLogger;
}

// Log lines and error messages in this file carry ids and codes only: never an email
// address, a meeting title, a user record, or anything read from a transcript or summary.
export class NotetakerNotificationService {
  constructor(private readonly deps: INotetakerNotificationServiceDeps) {}

  async send(params: NotetakerSendNotificationPayload): Promise<void> {
    switch (params.kind) {
      case "RESULTS_READY":
        return this.sendResultsReady(params);
      case "ATTENDEE_NOTICE":
        return this.sendAttendeeNotice(params.bookingId);
      default:
        // Thrown rather than skipped so a kind enqueued without a handler fails its task visibly.
        throw ErrorWithCode.Factory.InternalServerError(
          `NotetakerNotificationService: no handler for notification kind ${params.kind}`
        );
    }
  }

  // A target that cannot be notified is logged and dropped instead of thrown:
  // retrying the task would never make it sendable.
  private async sendResultsReady(params: { bookingId: number; sessionId: string | null }): Promise<void> {
    const { bookingId, sessionId } = params;
    const { bookingNotetakerRepository, sessionRepository, transcriptRepository, summaryRepository, logger } =
      this.deps;

    const booking = await bookingNotetakerRepository.findByBookingIdIncludeBooking(bookingId);
    if (!booking) {
      logger.warn("Notetaker results notification skipped: booking not found", { bookingId, sessionId });
      return;
    }

    if (sessionId === null) {
      logger.warn("Notetaker results notification skipped: no session id", { bookingId });
      return;
    }

    const session = await sessionRepository.findById(sessionId);
    if (!session) {
      logger.warn("Notetaker results notification skipped: session not found", { bookingId, sessionId });
      return;
    }
    if (session.bookingId !== booking.id) {
      logger.warn("Notetaker results notification skipped: session belongs to another booking", {
        bookingId,
        sessionId,
      });
      return;
    }
    const sessionStatus = session.status;
    if (sessionStatus !== "READY" && sessionStatus !== "ENDED_EARLY") {
      logger.warn("Notetaker results notification skipped: session has no results", {
        bookingId,
        sessionId,
        status: sessionStatus,
      });
      return;
    }
    if (session.resultsDeletedAt !== null) {
      logger.warn("Notetaker results notification skipped: results were deleted", { bookingId, sessionId });
      return;
    }

    const transcript = await transcriptRepository.findBySessionId(session.id);
    if (!transcript) {
      logger.warn("Notetaker results notification skipped: transcript not found", { bookingId, sessionId });
      return;
    }
    const summary = await summaryRepository.findByTranscriptId(transcript.id);
    const summaryStatus = summary?.status ?? null;

    const recipients = await this.resolveHostRecipients(booking);
    if (recipients.length === 0) {
      logger.warn("Notetaker results notification skipped: no recipient", { bookingId, sessionId });
      return;
    }

    // Every recipient is attempted before failing, so one bad address does not cost the others their email.
    let failureCount = 0;
    for (let i = 0; i < recipients.length; i++) {
      const user = recipients[i];
      try {
        const locale = user.locale ?? "en";
        const t = await getTranslation(locale, "common");
        await sendNotetakerResultsReadyEmail({
          t,
          locale,
          timeZone: user.timeZone,
          to: { email: user.email, name: user.name },
          bookingTitle: booking.title,
          bookingStartTime: booking.startTime,
          resultsUrl: `${WEBAPP_URL}/booking/${booking.uid}/notetaker`,
          sessionStatus,
          outcomeReason: session.outcomeReason,
          transcriptCompleteness: transcript.completeness,
          summaryStatus,
        });
      } catch (error) {
        failureCount++;
        logger.error("Failed to send the notetaker results email", {
          bookingId,
          sessionId,
          userId: user.id,
          error: getErrorMessage(error),
        });
      }
    }

    if (failureCount > 0) {
      throw ErrorWithCode.Factory.InternalServerError(
        `NotetakerNotificationService: RESULTS_READY for booking ${bookingId} session ${sessionId} failed for ${failureCount} of ${recipients.length} recipients`
      );
    }
  }

  // A booking that no longer qualifies is logged and dropped instead of thrown:
  // retrying the task would never make it sendable.
  private async sendAttendeeNotice(bookingId: number): Promise<void> {
    const { bookingNotetakerRepository, logger } = this.deps;

    const booking = await bookingNotetakerRepository.findByBookingIdIncludeBooking(bookingId);
    if (!booking) {
      logger.warn("Notetaker attendee notice skipped: booking not found", { bookingId });
      return;
    }
    if (booking.choice === null || !booking.choice.enabled) {
      logger.warn("Notetaker attendee notice skipped: notetaker is not enabled", { bookingId });
      return;
    }
    if (booking.status === "CANCELLED" || booking.status === "REJECTED") {
      logger.warn("Notetaker attendee notice skipped: booking is not active", {
        bookingId,
        status: booking.status,
      });
      return;
    }

    const attendees = await bookingNotetakerRepository.findAttendeesByBookingId(booking.id);
    const recipients = await this.resolveNoticeRecipients(booking, attendees);
    if (recipients.length === 0) return;

    const hostName = getNotetakerHostName(booking.organizer);
    const isPending = booking.status !== "ACCEPTED";

    // Sent whatever the event type's email settings are, because it is a transparency notice.
    const sentEmails: string[] = [];
    let failureCount = 0;
    for (let i = 0; i < recipients.length; i++) {
      const attendee = recipients[i];
      try {
        const locale = attendee.locale ?? "en";
        const t = await getTranslation(locale, "common");
        await sendNotetakerAttendeeNoticeEmail({
          t,
          locale,
          timeZone: attendee.timeZone,
          to: { email: attendee.email, name: attendee.name.trim() === "" ? null : attendee.name },
          bookingTitle: booking.title,
          bookingStartTime: booking.startTime,
          hostName,
          isPending,
        });
        sentEmails.push(attendee.email);
      } catch (error) {
        failureCount++;
        logger.error("Failed to send the notetaker attendee notice", {
          bookingId,
          error: getErrorMessage(error),
        });
      }
    }

    // Recorded after the send and before the throw so a retry reaches only the people not yet told.
    if (sentEmails.length > 0) {
      await bookingNotetakerRepository.appendNotifiedAttendeeEmails(booking.id, sentEmails, new Date());
    }

    if (failureCount > 0) {
      throw ErrorWithCode.Factory.InternalServerError(
        `NotetakerNotificationService: ATTENDEE_NOTICE for booking ${bookingId} failed for ${failureCount} of ${recipients.length} recipients`
      );
    }
  }

  private async resolveNoticeRecipients(
    booking: NotetakerBookingContext,
    attendees: NotetakerAttendeeRecord[]
  ): Promise<NotetakerAttendeeRecord[]> {
    if (booking.choice === null) return [];

    const seen = new Set<string>();
    const own = booking.choice.notifiedAttendeeEmails;
    for (let i = 0; i < own.length; i++) seen.add(normalizeEmail(own[i]));

    if (booking.recurringEventId !== null) {
      const series = await this.deps.bookingNotetakerRepository.findNotifiedAttendeeEmailsByRecurringEventId(
        booking.recurringEventId
      );
      for (let i = 0; i < series.length; i++) seen.add(normalizeEmail(series[i]));
    }

    const recipients: NotetakerAttendeeRecord[] = [];
    for (let i = 0; i < attendees.length; i++) {
      const attendee = attendees[i];
      const key = normalizeEmail(attendee.email);
      if (seen.has(key)) continue;
      seen.add(key);
      recipients.push(attendee);
    }
    return recipients;
  }

  private async resolveHostRecipients(booking: NotetakerBookingContext): Promise<NotetakerUserRecord[]> {
    const { activityRepository, userRepository, logger } = this.deps;

    let ids = await activityRepository.findDistinctActorUserIdsByBookingIdAndAction({
      bookingId: booking.id,
      action: "ENABLED",
    });
    // No host enabled it by hand, so the choice was inherited from the event type: the organizer owns it.
    if (ids.length === 0 && booking.userId !== null) ids = [booking.userId];
    if (ids.length === 0) return [];

    const users = await userRepository.findByIds({ ids });
    const usersById = new Map<number, NotetakerUserRecord>();
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      // Copied field by field: the lookup may be backed by a query that returns secret columns.
      usersById.set(user.id, {
        id: user.id,
        name: user.name,
        email: user.email,
        locale: user.locale,
        timeZone: user.timeZone,
      });
    }

    const recipients: NotetakerUserRecord[] = [];
    for (let i = 0; i < ids.length; i++) {
      const user = usersById.get(ids[i]);
      if (!user) {
        logger.warn("Notetaker results notification recipient not found", {
          bookingId: booking.id,
          userId: ids[i],
        });
        continue;
      }
      // Keyed by id above, so a repeated id cannot produce a second email.
      usersById.delete(ids[i]);
      recipients.push(user);
    }
    return recipients;
  }
}
