import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { getTranslation } from "@calcom/i18n/server";
import { APP_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import type { INotetakerBotGatewayResolver, NotetakerBotGatewayBinding } from "../bot/INotetakerBotGateway";
import { getNotetakerBotGatewayFailure } from "../bot/INotetakerBotGateway";
import type { NotetakerConfig } from "../lib/config";
import { NOTETAKER_SWEEP_BATCH_SIZE } from "../lib/config";
import { getBookingNotetakerEligibility, resolveMeetingLink } from "../lib/eligibility";
import { getNotetakerHostName } from "../lib/hostName";
import { getProcessingOutcomeReason, NOTETAKER_LIVE_SESSION_STATUSES } from "../lib/sessionStateMachine";
import type { INotetakerTasker } from "../lib/tasker/types";
import type { INotetakerUserLookup } from "../lib/userLookup";
import type {
  IBookingNotetakerRepository,
  NotetakerBookingContext,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type { INotetakerActivityRepository } from "../repositories/interfaces/INotetakerActivityRepository";
import type {
  INotetakerSessionRepository,
  NotetakerSessionRecord,
} from "../repositories/interfaces/INotetakerSessionRepository";
import type { NotetakerAccessService } from "./NotetakerAccessService";

const STARTED_LATE_THRESHOLD_MS = 60_000;

// Enabling inside the join-lead window enqueues the enable-time notice and this one milliseconds
// apart; without a delay both tasks would read the same recipient list and both would send.
const ATTENDEE_NOTICE_DELAY = "30s";

type PreparedSession = { session: NotetakerSessionRecord; joinRequest: NotetakerBotJoinRequest };

type HostStop = {
  bookingId: number;
  session: NotetakerSessionRecord;
  binding: NotetakerBotGatewayBinding | null;
  userId: number;
  actorName: string | null;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export interface INotetakerDispatchServiceDeps {
  bookingNotetakerRepository: IBookingNotetakerRepository;
  sessionRepository: INotetakerSessionRepository;
  activityRepository: INotetakerActivityRepository;
  botGatewayResolver: INotetakerBotGatewayResolver;
  config: NotetakerConfig;
  logger: ISimpleLogger;
  accessService: NotetakerAccessService;
  userRepository: INotetakerUserLookup;
  notetakerTasker: INotetakerTasker;
}

export class NotetakerDispatchService {
  constructor(private readonly deps: INotetakerDispatchServiceDeps) {}

  async dispatchDue(): Promise<void> {
    const { bookingNotetakerRepository, botGatewayResolver, config, logger } = this.deps;

    const binding = botGatewayResolver.resolve();
    if (!binding) {
      logger.error("Notetaker sweep skipped: bot provider is not usable");
      return;
    }

    const now = new Date();
    const candidates = await bookingNotetakerRepository.findEnabledIncludeBooking({
      bookingStatuses: ["ACCEPTED"],
      startTimeLte: new Date(now.getTime() + config.limits.joinLeadSeconds * 1000),
      endTimeGt: now,
      pendingDispatch: true,
      limit: NOTETAKER_SWEEP_BATCH_SIZE,
    });

    for (const booking of candidates) {
      try {
        await this.dispatchBooking(booking, binding);
      } catch (error) {
        logger.error("Notetaker dispatch failed", {
          bookingId: booking.id,
          message: getErrorMessage(error),
        });
      }
    }
  }

  async dispatchForBooking(params: { bookingUid: string }): Promise<void> {
    const { bookingNotetakerRepository, botGatewayResolver, config, logger } = this.deps;

    const binding = botGatewayResolver.resolve();
    if (!binding) {
      logger.error("Notetaker dispatch skipped: bot provider is not usable");
      return;
    }

    const booking = await bookingNotetakerRepository.findByBookingUidIncludeBooking(params.bookingUid);
    if (!booking) return;
    if (!booking.choice?.enabled || !booking.choice.pendingDispatch) return;
    if (booking.status !== "ACCEPTED") return;

    const nowMs = Date.now();
    if (booking.startTime.getTime() > nowMs + config.limits.joinLeadSeconds * 1000) return;
    if (booking.endTime.getTime() <= nowMs) return;

    await this.dispatchBooking(booking, binding);
  }

  async stopForBooking(
    params:
      | { bookingUid: string; reason: "DISABLED" }
      | { bookingUid: string; reason: "STOPPED_BY_HOST"; userId: number }
  ): Promise<void> {
    if (params.reason === "STOPPED_BY_HOST") {
      return this.stopByHost({ bookingUid: params.bookingUid, userId: params.userId });
    }

    const { bookingNotetakerRepository, sessionRepository, botGatewayResolver, logger } = this.deps;

    const booking = await bookingNotetakerRepository.findByBookingUidIncludeBooking(params.bookingUid);
    if (!booking) return;

    const session = await sessionRepository.findByBookingIdAndStatusIn(booking.id, [
      "SCHEDULED",
      "WAITING_TO_BE_ADMITTED",
    ]);
    if (!session) return;

    const binding = botGatewayResolver.resolve();
    if (binding) {
      try {
        await binding.gateway.requestStop({ sessionId: session.id, reason: params.reason });
      } catch (error) {
        logger.warn("Notetaker stop request failed", {
          bookingId: booking.id,
          sessionId: session.id,
          message: getErrorMessage(error),
        });
      }
    }

    // Deleted even when the bot could not be reached: a pre-admission row has no results to keep,
    // and leaving it would block the next dispatch for this booking.
    await sessionRepository.deleteById(session.id);
  }

  private async stopByHost(params: { bookingUid: string; userId: number }): Promise<void> {
    const { accessService, sessionRepository, botGatewayResolver } = this.deps;

    const booking = await accessService.assertHost(params);

    const session = await sessionRepository.findByBookingIdAndStatusIn(booking.id, [
      "SCHEDULED",
      "WAITING_TO_BE_ADMITTED",
      "TRANSCRIBING",
    ]);
    if (!session) throw ErrorWithCode.Factory.BadRequest("NO_ACTIVE_SESSION");

    const binding = botGatewayResolver.resolve();
    const actorName = await this.findUserName(params.userId);
    const stop = { bookingId: booking.id, session, binding, userId: params.userId, actorName };

    if (session.status === "TRANSCRIBING") return this.stopAfterAdmission(stop);
    return this.stopBeforeAdmission(stop);
  }

  private async stopBeforeAdmission(params: HostStop): Promise<void> {
    const { bookingNotetakerRepository, sessionRepository, activityRepository, logger } = this.deps;
    const { bookingId, session, binding, userId, actorName } = params;

    if (binding) {
      try {
        await binding.gateway.requestStop({ sessionId: session.id, reason: "STOPPED_BY_HOST" });
      } catch (error) {
        logger.warn("Notetaker stop request failed", {
          bookingId,
          sessionId: session.id,
          message: getErrorMessage(error),
        });
      }
    }

    // A false result means a concurrent stop already removed the row and recorded the act.
    const deleted = await sessionRepository.deleteById(session.id);
    if (!deleted) return;

    // Without this the booking would read as scheduled for ever, and the host could not turn the
    // notetaker on again because enabling an enabled choice is a no-op.
    await bookingNotetakerRepository.disable(bookingId);
    await activityRepository.create({
      bookingId,
      sessionId: null,
      action: "STOPPED",
      actorType: "USER",
      actorUserId: userId,
      actorName,
      detail: null,
    });
  }

  private async stopAfterAdmission(params: HostStop): Promise<void> {
    const { bookingNotetakerRepository, sessionRepository, activityRepository } = this.deps;
    const { bookingId, session, binding, userId, actorName } = params;
    const now = new Date();

    if (session.stopRequestedAt === null) {
      const marked = await sessionRepository.updateIfStatusIn(session.id, ["TRANSCRIBING"], {
        stopRequestedAt: now,
        stopRequestedByUserId: userId,
      });
      // The session ended by itself between the read and the mark; there is nothing left to stop.
      if (!marked) return;

      await activityRepository.create({
        bookingId,
        sessionId: session.id,
        action: "STOPPED",
        actorType: "USER",
        actorUserId: userId,
        actorName,
        detail: null,
      });
    }

    // Not caught: the host has to see that the bot was not reached, and presses Stop again. The
    // mark above keeps that repeat from writing a second activity.
    if (binding) {
      await binding.gateway.requestStop({ sessionId: session.id, reason: "STOPPED_BY_HOST" });
    }

    if (await this.isSessionKnownToBot(binding, session.id)) return;

    // Both before the status write, so no sweep can pass the live-session precondition in between
    // and send a second bot.
    await bookingNotetakerRepository.setRejoinBlocked(bookingId, true);
    await bookingNotetakerRepository.setPendingDispatch(bookingId, false);

    const won = await sessionRepository.updateIfStatusIn(session.id, ["TRANSCRIBING"], {
      status: "PROCESSING",
      outcomeReason: getProcessingOutcomeReason("STOP_REQUESTED"),
      endedAt: now,
    });
    if (!won) return;

    await this.enqueueFinalize(session.id);
  }

  // requestStop resolves for a session the bot does not know as well, so asking for the state is
  // the only way to see that the bot lost the session and will never report its end.
  private async isSessionKnownToBot(
    binding: NotetakerBotGatewayBinding | null,
    sessionId: string
  ): Promise<boolean> {
    if (!binding) return false;

    try {
      return (await binding.gateway.getState(sessionId)) !== null;
    } catch (error) {
      this.deps.logger.warn("Notetaker state request failed; the session is left to the bot", {
        sessionId,
        message: getErrorMessage(error),
      });
      return true;
    }
  }

  private async findUserName(userId: number): Promise<string | null> {
    const users = await this.deps.userRepository.findByIds({ ids: [userId] });
    return users.find((user) => user.id === userId)?.name ?? null;
  }

  private async enqueueFinalize(sessionId: string): Promise<void> {
    const { runId } = await this.deps.notetakerTasker.finalizeSession({ sessionId });
    if (runId !== "task-failed") return;

    this.deps.logger.error("Failed to enqueue notetaker session finalize", { sessionId });
    throw ErrorWithCode.Factory.InternalServerError(
      `Unable to enqueue finalize for notetaker session ${sessionId}`
    );
  }

  private async enqueueAttendeeNotice(bookingId: number, sessionId: string): Promise<void> {
    const { runId } = await this.deps.notetakerTasker.sendNotification(
      { kind: "ATTENDEE_NOTICE", bookingId, sessionId },
      { delay: ATTENDEE_NOTICE_DELAY }
    );
    if (runId !== "task-failed") return;

    // Not thrown: the bot is already joining, and its own notice in the meeting still appears.
    this.deps.logger.error("Failed to enqueue notetaker attendee notice", { bookingId, sessionId });
  }

  private async dispatchBooking(
    booking: NotetakerBookingContext,
    binding: NotetakerBotGatewayBinding
  ): Promise<void> {
    const { bookingNotetakerRepository, sessionRepository } = this.deps;

    // Checked before the swap so a choice re-armed during a live session stays armed for later.
    const liveSession = await sessionRepository.findByBookingIdAndStatusIn(
      booking.id,
      NOTETAKER_LIVE_SESSION_STATUSES
    );
    if (liveSession) return;

    const wonSwap = await bookingNotetakerRepository.clearPendingDispatch(booking.id);
    if (!wonSwap) return;

    let prepared: PreparedSession | null;
    try {
      prepared = await this.prepareSession(booking, binding);
    } catch (error) {
      // Nothing was dispatched, so without re-arming the choice would stay disarmed for good.
      await bookingNotetakerRepository.setPendingDispatch(booking.id, true);
      throw error;
    }
    if (!prepared) return;

    let externalRef: string;
    try {
      ({ externalRef } = await binding.gateway.requestJoin(prepared.joinRequest));
    } catch (error) {
      await this.handleJoinFailure(booking.id, prepared.session.id, error);
      return;
    }

    // Outside the try above: a failed write here must not be handled as a gateway failure, because
    // re-arming with a live session would dispatch a second bot once that session ends. The bot's
    // events can already be changing the row, so this is the only column written after the join.
    await sessionRepository.update(prepared.session.id, { externalRef });

    await this.enqueueAttendeeNotice(booking.id, prepared.session.id);
  }

  private async prepareSession(
    booking: NotetakerBookingContext,
    binding: NotetakerBotGatewayBinding
  ): Promise<PreparedSession | null> {
    const { bookingNotetakerRepository, sessionRepository, activityRepository, config } = this.deps;
    const { location, metadata, references } = booking;

    const eligibility = getBookingNotetakerEligibility({
      location,
      metadata,
      references,
      bookingStatus: booking.status,
      enabledPlatforms: config.enabledPlatforms,
    });
    const { platform } = eligibility;
    const meetingUrl = eligibility.eligible ? resolveMeetingLink({ location, metadata, references }) : null;
    const isSupportedTypeWithoutLink = eligibility.reason === "NO_MEETING_LINK";

    if (platform === null || (meetingUrl === null && !isSupportedTypeWithoutLink)) {
      await bookingNotetakerRepository.disable(booking.id);
      await activityRepository.create({
        bookingId: booking.id,
        sessionId: null,
        action: "DISABLED",
        actorType: "SYSTEM",
        actorUserId: null,
        actorName: null,
        detail: { reason: "UNSUPPORTED_LOCATION" },
      });
      return null;
    }

    const now = new Date();
    const t = await getTranslation(booking.organizer?.locale ?? "en", "common");
    const hostName = getNotetakerHostName(booking.organizer);
    const displayName = t("notetaker_display_name", { appName: APP_NAME, hostName });
    const startedLate = now.getTime() > booking.startTime.getTime() + STARTED_LATE_THRESHOLD_MS;

    if (meetingUrl === null) {
      await sessionRepository.create({
        bookingId: booking.id,
        platform,
        meetingUrl: "",
        botProvider: binding.provider,
        displayName,
        scheduledStartAt: booking.startTime,
        dispatchedAt: now,
        startedLate,
        status: "FAILED",
        outcomeReason: "MEETING_LINK_UNUSABLE",
        endedAt: now,
      });
      return null;
    }

    const session = await sessionRepository.create({
      bookingId: booking.id,
      platform,
      meetingUrl,
      botProvider: binding.provider,
      displayName,
      scheduledStartAt: booking.startTime,
      dispatchedAt: now,
      startedLate,
    });

    return {
      session,
      joinRequest: {
        sessionId: session.id,
        platform,
        meetingUrl,
        displayName,
        noticeMessage: t("notetaker_meeting_notice", { hostName }),
        scheduledStartAt: booking.startTime.toISOString(),
        callbackUrl: `${WEBAPP_URL}/api/notetaker/events`,
        limits: {
          admissionTimeoutSeconds: config.limits.admissionTimeoutSeconds,
          noShowTimeoutSeconds: config.limits.noShowTimeoutSeconds,
          aloneTimeoutSeconds: config.limits.aloneTimeoutSeconds,
          maxDurationSeconds: config.limits.maxDurationSeconds,
        },
      },
    };
  }

  private async handleJoinFailure(bookingId: number, sessionId: string, error: unknown): Promise<void> {
    const { bookingNotetakerRepository, sessionRepository, logger } = this.deps;

    if (getNotetakerBotGatewayFailure(error) === "LINK_UNUSABLE") {
      // A false result means the row already left SCHEDULED; that transition wins.
      await sessionRepository.updateIfStatusIn(sessionId, ["SCHEDULED"], {
        status: "FAILED",
        outcomeReason: "MEETING_LINK_UNUSABLE",
        endedAt: new Date(),
      });
      return;
    }

    // The row goes first so the next sweep's live-session precondition lets the retry through.
    await sessionRepository.deleteById(sessionId);
    await bookingNotetakerRepository.setPendingDispatch(bookingId, true);
    logger.warn("Notetaker join request failed; the next sweep retries", {
      bookingId,
      sessionId,
      message: getErrorMessage(error),
    });
  }
}
