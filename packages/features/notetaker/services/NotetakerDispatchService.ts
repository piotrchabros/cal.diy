import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import { getTranslation } from "@calcom/i18n/server";
import { APP_NAME, WEBAPP_URL } from "@calcom/lib/constants";
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import type { INotetakerBotGatewayResolver, NotetakerBotGatewayBinding } from "../bot/INotetakerBotGateway";
import { getNotetakerBotGatewayFailure } from "../bot/INotetakerBotGateway";
import type { NotetakerConfig } from "../lib/config";
import { NOTETAKER_SWEEP_BATCH_SIZE } from "../lib/config";
import { getBookingNotetakerEligibility, resolveMeetingLink } from "../lib/eligibility";
import { NOTETAKER_LIVE_SESSION_STATUSES } from "../lib/sessionStateMachine";
import type {
  IBookingNotetakerRepository,
  NotetakerBookingContext,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type { INotetakerActivityRepository } from "../repositories/interfaces/INotetakerActivityRepository";
import type {
  INotetakerSessionRepository,
  NotetakerSessionRecord,
} from "../repositories/interfaces/INotetakerSessionRepository";

const STARTED_LATE_THRESHOLD_MS = 60_000;

type PreparedSession = { session: NotetakerSessionRecord; joinRequest: NotetakerBotJoinRequest };

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

  async stopForBooking(params: { bookingUid: string; reason: "DISABLED" }): Promise<void> {
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
    const hostName = booking.organizer?.name ?? APP_NAME;
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
