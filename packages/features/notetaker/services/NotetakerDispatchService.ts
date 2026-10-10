import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { getTranslation } from "@calcom/i18n/server";
import { APP_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import type { NotetakerOutcomeReasonDto, NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerBotJoinRequest, NotetakerBotStopReason } from "@calcom/lib/notetaker/botContract";
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
  NotetakerBookingStatus,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type { INotetakerActivityRepository } from "../repositories/interfaces/INotetakerActivityRepository";
import type {
  INotetakerSessionRepository,
  NotetakerSessionRecord,
} from "../repositories/interfaces/INotetakerSessionRepository";
import type { NotetakerAccessService } from "./NotetakerAccessService";
import type { NotetakerCalendarInviteService } from "./NotetakerCalendarInviteService";

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

export function getNotetakerGiveUpDeadline(params: {
  startTime: Date;
  endTime: Date;
  setAt: Date;
  noShowTimeoutSeconds: number;
}): Date {
  const { startTime, endTime, setAt, noShowTimeoutSeconds } = params;
  return new Date(
    Math.min(endTime.getTime(), Math.max(startTime.getTime(), setAt.getTime()) + noShowTimeoutSeconds * 1000)
  );
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
  calendarInviteService: Pick<NotetakerCalendarInviteService, "ensureBotInvited">;
}

export class NotetakerDispatchService {
  constructor(private readonly deps: INotetakerDispatchServiceDeps) {}

  async dispatchDue(): Promise<void> {
    const { botGatewayResolver, logger } = this.deps;

    const binding = botGatewayResolver.resolve();
    if (!binding) {
      logger.error("Notetaker sweep skipped: bot provider is not usable");
      return;
    }

    const now = new Date();
    // In this order: a join that failed and re-armed the choice is given up in the same run once
    // its deadline has passed.
    await this.runSweepStep("dispatch", () => this.dispatchArmed(now, binding));
    await this.runSweepStep("give-up", () => this.giveUpOverdue(now, binding));
    await this.runSweepStep("void-unconfirmed", () => this.voidUnconfirmed(now));
    await this.runSweepStep("watchdog", () => this.runWatchdog(now, binding));
  }

  // One step's failing query must not stop the steps after it.
  private async runSweepStep(
    step: "dispatch" | "give-up" | "void-unconfirmed" | "watchdog",
    run: () => Promise<void>
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.deps.logger.error("Notetaker sweep step failed", { step, message: getErrorMessage(error) });
    }
  }

  private async dispatchArmed(now: Date, binding: NotetakerBotGatewayBinding): Promise<void> {
    const { bookingNotetakerRepository, config, logger } = this.deps;

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

  private async giveUpOverdue(now: Date, binding: NotetakerBotGatewayBinding): Promise<void> {
    const { bookingNotetakerRepository, logger } = this.deps;

    // No endTimeGt: a booking past its end is due as well, its deadline being the end itself.
    const candidates = await bookingNotetakerRepository.findEnabledIncludeBooking({
      bookingStatuses: ["ACCEPTED"],
      startTimeLte: now,
      pendingDispatch: true,
      limit: NOTETAKER_SWEEP_BATCH_SIZE,
    });

    for (const booking of candidates) {
      try {
        await this.giveUpBooking(booking, binding, now);
      } catch (error) {
        logger.error("Notetaker give-up failed", {
          bookingId: booking.id,
          message: getErrorMessage(error),
        });
      }
    }
  }

  private async giveUpBooking(
    booking: NotetakerBookingContext,
    binding: NotetakerBotGatewayBinding,
    now: Date
  ): Promise<void> {
    const { bookingNotetakerRepository, sessionRepository, config } = this.deps;
    const { location, metadata, references, choice } = booking;
    if (!choice) return;

    const deadline = getNotetakerGiveUpDeadline({
      startTime: booking.startTime,
      endTime: booking.endTime,
      setAt: choice.setAt,
      noShowTimeoutSeconds: config.limits.noShowTimeoutSeconds,
    });
    if (deadline.getTime() > now.getTime()) return;

    // Checked before the swap so a choice re-armed during a live session stays armed for later; a
    // FAILED row beside that session would also become the latest one and hide its status.
    const liveSession = await sessionRepository.findByBookingIdAndStatusIn(
      booking.id,
      NOTETAKER_LIVE_SESSION_STATUSES
    );
    if (liveSession) return;

    const wonSwap = await bookingNotetakerRepository.clearPendingDispatch(booking.id);
    if (!wonSwap) return;

    let session: NotetakerSessionRecord;
    try {
      const { platform } = getBookingNotetakerEligibility({
        location,
        metadata,
        references,
        bookingStatus: booking.status,
        enabledPlatforms: config.enabledPlatforms,
      });
      if (platform === null) {
        await this.disableUnsupported(booking);
        return;
      }

      session = await this.createFailedSession(booking, binding, {
        platform,
        meetingUrl: resolveMeetingLink({ location, metadata, references }) ?? "",
        outcomeReason: "INTERRUPTED",
        now,
      });
    } catch (error) {
      // Nothing was recorded, so without re-arming the host would never hear that it failed.
      await bookingNotetakerRepository.setPendingDispatch(booking.id, true);
      throw error;
    }

    await this.enqueueFailedNotice(booking.id, session.id);
  }

  private async voidUnconfirmed(now: Date): Promise<void> {
    const { bookingNotetakerRepository, logger } = this.deps;

    const candidates = await bookingNotetakerRepository.findEnabledIncludeBooking({
      bookingStatuses: ["PENDING", "AWAITING_HOST"],
      startTimeLte: now,
      limit: NOTETAKER_SWEEP_BATCH_SIZE,
    });

    for (const booking of candidates) {
      try {
        await this.voidChoice(booking.id, "BOOKING_NOT_CONFIRMED");
      } catch (error) {
        logger.error("Notetaker voiding failed", {
          bookingId: booking.id,
          message: getErrorMessage(error),
        });
      }
    }
  }

  private async voidChoice(
    bookingId: number,
    reason: "BOOKING_NOT_CONFIRMED" | "BOOKING_NOT_ACTIVE"
  ): Promise<void> {
    const { bookingNotetakerRepository, activityRepository } = this.deps;

    // Only the call that flipped the row records it, so two concurrent sweeps write one activity.
    const voided = await bookingNotetakerRepository.disableIfEnabled(bookingId);
    if (!voided) return;

    await activityRepository.create({
      bookingId,
      sessionId: null,
      action: "DISABLED",
      actorType: "SYSTEM",
      actorUserId: null,
      actorName: null,
      detail: { reason },
    });
  }

  private async runWatchdog(now: Date, binding: NotetakerBotGatewayBinding): Promise<void> {
    const { sessionRepository, logger } = this.deps;

    const sessions = await sessionRepository.findByStatusInIncludeBooking({
      statuses: NOTETAKER_LIVE_SESSION_STATUSES,
      limit: NOTETAKER_SWEEP_BATCH_SIZE,
    });

    for (const session of sessions) {
      try {
        await this.watchSession(session, binding, now);
      } catch (error) {
        logger.error("Notetaker watchdog failed", {
          bookingId: session.bookingId,
          sessionId: session.id,
          message: getErrorMessage(error),
        });
      }
    }
  }

  private async watchSession(
    session: NotetakerSessionRecord & { bookingStatus: NotetakerBookingStatus },
    binding: NotetakerBotGatewayBinding,
    now: Date
  ): Promise<void> {
    const { sessionRepository, notetakerTasker, config, logger } = this.deps;
    const { id, bookingId } = session;
    const timeoutMs = config.limits.heartbeatTimeoutSeconds * 1000;
    const nowMs = now.getTime();

    if (session.status === "PROCESSING") {
      const since = (session.endedAt ?? session.dispatchedAt).getTime();
      if (nowMs - since < timeoutMs) return;

      // A finalize whose enqueue failed would leave the session PROCESSING for good. The key makes
      // the task runner drop the repeats of a finalize that is merely slow.
      const { runId } = await notetakerTasker.finalizeSession(
        { sessionId: id },
        { idempotencyKey: `notetaker:finalize:${id}` }
      );
      // Not thrown: nothing was written, and the next sweep asks again.
      if (runId === "task-failed") {
        logger.error("Failed to re-enqueue notetaker session finalize", { sessionId: id });
      }
      return;
    }

    const admitted = session.admittedAt !== null;

    if (session.bookingStatus !== "ACCEPTED") {
      await this.requestStopBestEffort(binding, id, "BOOKING_NOT_ACTIVE");
      if (!admitted) {
        await sessionRepository.deleteById(id);
        await this.voidChoice(bookingId, "BOOKING_NOT_ACTIVE");
        return;
      }
      // Not returned: a live bot ends the session itself, but a dead one never reports, so the
      // heartbeat check below still has to finalize what was recorded.
    }

    const since = Math.max(session.dispatchedAt.getTime(), session.lastHeartbeatAt?.getTime() ?? 0);
    if (nowMs - since < timeoutMs) return;

    // The wire contract has no reason for a lost bot; this one makes a bot that is only cut off
    // from us leave without posting anything.
    await this.requestStopBestEffort(binding, id, "DISABLED");

    if (!admitted) {
      const failed = await sessionRepository.updateIfStatusIn(id, ["SCHEDULED", "WAITING_TO_BE_ADMITTED"], {
        status: "FAILED",
        outcomeReason: "INTERRUPTED",
        endedAt: now,
      });
      if (failed) await this.enqueueFailedNotice(bookingId, id);
      return;
    }

    const won = await sessionRepository.updateIfStatusIn(id, ["TRANSCRIBING"], {
      status: "PROCESSING",
      outcomeReason: "INTERRUPTED",
      endedAt: now,
    });
    if (won) await this.enqueueFinalize(id);
  }

  private async requestStopBestEffort(
    binding: NotetakerBotGatewayBinding,
    sessionId: string,
    reason: NotetakerBotStopReason
  ): Promise<void> {
    try {
      await binding.gateway.requestStop({ sessionId, reason });
    } catch (error) {
      this.deps.logger.warn("Notetaker stop request failed", {
        sessionId,
        reason,
        message: getErrorMessage(error),
      });
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

  private async enqueueFailedNotice(bookingId: number, sessionId: string): Promise<void> {
    const { runId } = await this.deps.notetakerTasker.sendNotification(
      { kind: "FAILED", bookingId, sessionId },
      { idempotencyKey: `notetaker:FAILED:${sessionId}` }
    );
    if (runId !== "task-failed") return;

    // Not thrown: the session is already final, and failing the row would not send the notice.
    this.deps.logger.error("Failed to enqueue notetaker failed notice", { bookingId, sessionId });
  }

  private async enqueueTurnedOffNotice(bookingId: number): Promise<void> {
    const { runId } = await this.deps.notetakerTasker.sendNotification({
      kind: "TURNED_OFF",
      bookingId,
      sessionId: null,
    });
    if (runId !== "task-failed") return;

    // Not thrown: the choice is already off, and failing the sweep would not send the notice.
    this.deps.logger.error("Failed to enqueue notetaker turned-off notice", { bookingId });
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

    // Before the join: the guest list has to change before the bot reaches the join screen, where Meet
    // decides between letting it in and making it ask.
    await this.inviteBotBestEffort(booking.id, prepared.joinRequest);

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

  private async inviteBotBestEffort(bookingId: number, joinRequest: NotetakerBotJoinRequest): Promise<void> {
    const { sessionId, platform, meetingUrl } = joinRequest;
    try {
      await this.deps.calendarInviteService.ensureBotInvited({ bookingId, sessionId, platform, meetingUrl });
    } catch (error) {
      // The invite service promises not to reject, but a rejection here would leave a session row with no
      // join request.
      this.deps.logger.warn("Notetaker calendar invite failed; the notetaker will ask to join", {
        bookingId,
        sessionId,
        message: getErrorMessage(error),
      });
    }
  }

  private async prepareSession(
    booking: NotetakerBookingContext,
    binding: NotetakerBotGatewayBinding
  ): Promise<PreparedSession | null> {
    const { sessionRepository, config } = this.deps;
    const { location, metadata, references } = booking;

    const eligibility = getBookingNotetakerEligibility({
      location,
      metadata,
      references,
      bookingStatus: booking.status,
      enabledPlatforms: config.enabledPlatforms,
    });
    const { platform } = eligibility;

    if (!eligibility.eligible || platform === null) {
      await this.disableUnsupported(booking);
      return null;
    }

    const meetingUrl = resolveMeetingLink({ location, metadata, references });
    const now = new Date();

    if (meetingUrl === null) {
      const session = await this.createFailedSession(booking, binding, {
        platform,
        meetingUrl: "",
        outcomeReason: "MEETING_LINK_UNUSABLE",
        now,
      });
      await this.enqueueFailedNotice(booking.id, session.id);
      return null;
    }

    const { t, hostName, displayName } = await this.resolveDisplay(booking);
    const startedLate = now.getTime() > booking.startTime.getTime() + STARTED_LATE_THRESHOLD_MS;
    const sharedWithColleagues = booking.teamId !== null && booking.sharingMode !== "HOSTS_ONLY";

    const session = await sessionRepository.create({
      bookingId: booking.id,
      platform,
      meetingUrl,
      botProvider: binding.provider,
      displayName,
      scheduledStartAt: booking.startTime,
      dispatchedAt: now,
      startedLate,
      colleagueSharingDisclosed: sharedWithColleagues,
    });

    return {
      session,
      joinRequest: {
        sessionId: session.id,
        platform,
        meetingUrl,
        displayName,
        noticeMessage: t(
          sharedWithColleagues ? "notetaker_meeting_notice_shared" : "notetaker_meeting_notice",
          {
            hostName,
          }
        ),
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

  private async disableUnsupported(booking: NotetakerBookingContext): Promise<void> {
    const { bookingNotetakerRepository, activityRepository } = this.deps;

    // Only the call that flipped the row records it and sends the notice, so two concurrent sweeps
    // produce one activity and one notice.
    const flipped = await bookingNotetakerRepository.disableIfEnabled(booking.id);
    if (!flipped) return;

    await activityRepository.create({
      bookingId: booking.id,
      sessionId: null,
      action: "DISABLED",
      actorType: "SYSTEM",
      actorUserId: null,
      actorName: null,
      detail: { reason: "UNSUPPORTED_LOCATION" },
    });
    await this.enqueueTurnedOffNotice(booking.id);
  }

  private async resolveDisplay(booking: NotetakerBookingContext): Promise<{
    t: Awaited<ReturnType<typeof getTranslation>>;
    hostName: string;
    displayName: string;
  }> {
    const t = await getTranslation(booking.organizer?.locale ?? "en", "common");
    const hostName = getNotetakerHostName(booking.organizer);
    const displayName = t("notetaker_display_name", { appName: APP_NAME, hostName });
    return { t, hostName, displayName };
  }

  private async createFailedSession(
    booking: NotetakerBookingContext,
    binding: NotetakerBotGatewayBinding,
    params: {
      platform: NotetakerPlatformDto;
      meetingUrl: string;
      outcomeReason: NotetakerOutcomeReasonDto;
      now: Date;
    }
  ): Promise<NotetakerSessionRecord> {
    const { platform, meetingUrl, outcomeReason, now } = params;
    const { displayName } = await this.resolveDisplay(booking);

    return this.deps.sessionRepository.create({
      bookingId: booking.id,
      platform,
      meetingUrl,
      botProvider: binding.provider,
      displayName,
      scheduledStartAt: booking.startTime,
      dispatchedAt: now,
      startedLate: now.getTime() > booking.startTime.getTime() + STARTED_LATE_THRESHOLD_MS,
      status: "FAILED",
      outcomeReason,
      endedAt: now,
    });
  }

  private async handleJoinFailure(bookingId: number, sessionId: string, error: unknown): Promise<void> {
    const { bookingNotetakerRepository, sessionRepository, logger } = this.deps;

    if (getNotetakerBotGatewayFailure(error) === "LINK_UNUSABLE") {
      // A false result means the row already left SCHEDULED; that transition wins.
      const failed = await sessionRepository.updateIfStatusIn(sessionId, ["SCHEDULED"], {
        status: "FAILED",
        outcomeReason: "MEETING_LINK_UNUSABLE",
        endedAt: new Date(),
      });
      if (failed) await this.enqueueFailedNotice(bookingId, sessionId);
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
