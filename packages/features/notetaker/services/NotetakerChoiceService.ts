import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { IFeaturesRepository } from "@calcom/features/flags/features.repository.interface";
import type { NotetakerSessionStatusDto, NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerSummaryDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type { NotetakerTranscriptDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerConfig } from "../lib/config";
import { isNotetakerBotProviderUsable } from "../lib/config";
import { getBookingNotetakerEligibility } from "../lib/eligibility";
import { getDisplayedStatus } from "../lib/sessionStateMachine";
import type { INotetakerTasker } from "../lib/tasker/types";
import type { INotetakerUserLookup } from "../lib/userLookup";
import type {
  BookingNotetakerRecord,
  IBookingNotetakerRepository,
  NotetakerBookingContext,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type { IEventTypeNotetakerSettingsRepository } from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";
import type { INotetakerActivityRepository } from "../repositories/interfaces/INotetakerActivityRepository";
import type {
  INotetakerSessionRepository,
  NotetakerSessionRecord,
} from "../repositories/interfaces/INotetakerSessionRepository";
import type {
  INotetakerSummaryRepository,
  NotetakerSummaryRecord,
} from "../repositories/interfaces/INotetakerSummaryRepository";
import type {
  INotetakerTranscriptRepository,
  NotetakerTranscriptRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";
import type { NotetakerAccessService } from "./NotetakerAccessService";

const NOTETAKER_FEATURE_SLUG = "notetaker";

const STOPPABLE_SESSION_STATUSES: NotetakerSessionStatusDto[] = [
  "SCHEDULED",
  "WAITING_TO_BE_ADMITTED",
  "TRANSCRIBING",
];

function toIsoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function toSessionDto(session: NotetakerSessionRecord): NonNullable<NotetakerStateDto["session"]> {
  return {
    id: session.id,
    status: session.status,
    outcomeReason: session.outcomeReason,
    startedLate: session.startedLate,
    joinRequestedAt: toIsoOrNull(session.joinRequestedAt),
    admittedAt: toIsoOrNull(session.admittedAt),
    endedAt: toIsoOrNull(session.endedAt),
    interruptedAtMs: session.interruptedAtMs,
    resultsDeletedAt: toIsoOrNull(session.resultsDeletedAt),
  };
}

function toTranscriptDto(transcript: NotetakerTranscriptRecord): NotetakerTranscriptDto {
  return {
    id: transcript.id,
    language: transcript.language,
    completeness: transcript.completeness,
    durationMs: transcript.durationMs,
    passageCount: transcript.passageCount,
  };
}

function toSummaryDto(summary: NotetakerSummaryRecord): NotetakerSummaryDto {
  return {
    status: summary.status,
    language: summary.language,
    overview: summary.overview,
    keyPoints: summary.keyPoints,
    decisions: summary.decisions,
    actionItems: summary.actionItems.map((item) => ({ text: item.text, owner: item.owner })),
    generatedAt: toIsoOrNull(summary.generatedAt),
  };
}

export interface INotetakerChoiceServiceDeps {
  bookingNotetakerRepository: IBookingNotetakerRepository;
  // Unused until event type defaults are applied; present so the constructor does not change then.
  eventTypeNotetakerSettingsRepository: IEventTypeNotetakerSettingsRepository;
  sessionRepository: INotetakerSessionRepository;
  transcriptRepository: INotetakerTranscriptRepository;
  summaryRepository: INotetakerSummaryRepository;
  activityRepository: INotetakerActivityRepository;
  accessService: NotetakerAccessService;
  featuresRepository: Pick<IFeaturesRepository, "checkIfUserHasFeature">;
  userRepository: INotetakerUserLookup;
  config: NotetakerConfig;
  notetakerTasker: INotetakerTasker;
  logger: ISimpleLogger;
}

export type NotetakerChoiceScope = "THIS_BOOKING" | "ALL_FUTURE_OCCURRENCES";

export class NotetakerChoiceService {
  constructor(private readonly deps: INotetakerChoiceServiceDeps) {}

  async setEnabled(params: {
    bookingUid: string;
    enabled: boolean;
    scope: NotetakerChoiceScope;
    userId: number;
  }): Promise<void> {
    const { bookingUid, enabled, userId } = params;

    const booking = await this.deps.accessService.assertHost({ bookingUid, userId });
    const now = new Date();
    const existing = booking.choice;

    if (!enabled) {
      // Turning off stays possible after the end time and on an ineligible booking.
      if (!existing?.enabled) return;
      await this.writeDisabledChoice({ booking, userId, now });
      return;
    }

    const featureEnabled = await this.isFeatureEnabled(userId);
    const eligibility = this.resolveEligibility(booking, featureEnabled, now);
    if (eligibility.reason !== null) {
      // Only the message reaches the client, so it carries the reason code itself.
      throw ErrorWithCode.Factory.BadRequest(eligibility.reason, { reason: eligibility.reason });
    }

    if (existing?.enabled) return;

    // Looked up before the write: the two writes share no transaction, so nothing that can fail sits between them.
    const actorName = await this.findUserName(userId);

    const won = await this.deps.bookingNotetakerRepository.enableIfDisabled({
      bookingId: booking.id,
      source: "HOST",
      appliedToSeries: false,
      setByUserId: userId,
      setAt: now,
    });
    if (!won) {
      const current = await this.deps.bookingNotetakerRepository.findByBookingId(booking.id);
      if (current?.rejoinBlocked === true) {
        throw ErrorWithCode.Factory.BadRequest("REJOIN_BLOCKED", { reason: "REJOIN_BLOCKED" });
      }
      // Another host enabled it first, so this call records no activity and sends no notice.
      return;
    }

    await this.createActivity({ bookingId: booking.id, action: "ENABLED", userId, actorName });

    const result = await this.deps.notetakerTasker.sendNotification({
      kind: "ATTENDEE_NOTICE",
      bookingId: booking.id,
      sessionId: null,
    });
    if (result.runId === "task-failed") {
      // The choice is stored, and the notice sent at dispatch time is the catch-all, so the host is not failed.
      this.deps.logger.error("Failed to enqueue the notetaker attendee notice", { bookingId: booking.id });
    }
  }

  async getState(params: { bookingUid: string; userId: number }): Promise<NotetakerStateDto> {
    const { bookingUid, userId } = params;

    const { role, booking } = await this.deps.accessService.resolveViewerRole({ bookingUid, userId });
    const now = new Date();

    const [featureEnabled, latestSession, latestWithTranscript, sharingGrant] = await Promise.all([
      this.isFeatureEnabled(userId),
      this.deps.sessionRepository.findLatestByBookingId(booking.id),
      this.deps.sessionRepository.findLatestWithTranscriptByBookingId(booking.id),
      this.deps.bookingNotetakerRepository.findSharingGrant(booking.id),
    ]);

    const choice = this.getEffectiveChoice(booking);
    const eligibility = this.resolveEligibility(booking, featureEnabled, now);
    const isHost = role === "HOST";

    const displayedStatus = getDisplayedStatus({
      choice,
      latestSessionStatus: latestSession?.status ?? null,
    });
    // "Enabled, not pending, no session" is unreachable by invariant; shown as SCHEDULED rather than as off.
    const status = displayedStatus ?? (choice?.enabled ? "SCHEDULED" : null);

    const transcript =
      latestWithTranscript && latestWithTranscript.session.resultsDeletedAt === null
        ? latestWithTranscript.transcript
        : null;
    const summary = transcript ? await this.deps.summaryRepository.findByTranscriptId(transcript.id) : null;

    let choiceDto: NotetakerStateDto["choice"] = null;
    if (isHost && choice) {
      choiceDto = {
        enabled: choice.enabled,
        source: choice.source,
        appliedToSeries: choice.appliedToSeries,
        setByName: choice.setByUserId === null ? null : await this.findUserName(choice.setByUserId),
        setAt: choice.setAt.toISOString(),
      };
    }

    return {
      bookingUid: booking.uid,
      featureEnabled,
      viewerRole: role,
      eligibility,
      choice: choiceDto,
      status,
      // An enabled choice can be turned off before the end even when ineligible, except once rejoin is
      // blocked: there the explanation replaces the toggle.
      canToggle:
        isHost &&
        !this.hasEnded(booking, now) &&
        booking.choice?.rejoinBlocked !== true &&
        (choice?.enabled === true || eligibility.eligible),
      canStop: isHost && latestSession !== null && STOPPABLE_SESSION_STATUSES.includes(latestSession.status),
      isRecurring: booking.recurringEventId !== null,
      session: latestSession ? toSessionDto(latestSession) : null,
      transcript: transcript ? toTranscriptDto(transcript) : null,
      summary: summary ? toSummaryDto(summary) : null,
      sharedWithAttendees: sharingGrant !== null,
    };
  }

  private async isFeatureEnabled(userId: number): Promise<boolean> {
    const hasFeature = await this.deps.featuresRepository.checkIfUserHasFeature(
      userId,
      NOTETAKER_FEATURE_SLUG
    );
    return hasFeature && isNotetakerBotProviderUsable(this.deps.config);
  }

  private hasEnded(booking: NotetakerBookingContext, now: Date): boolean {
    return booking.endTime.getTime() <= now.getTime();
  }

  private resolveEligibility(
    booking: NotetakerBookingContext,
    featureEnabled: boolean,
    now: Date
  ): NotetakerStateDto["eligibility"] {
    if (!featureEnabled) return { eligible: false, platform: null, reason: "FEATURE_DISABLED" };

    const eligibility = getBookingNotetakerEligibility({
      location: booking.location,
      metadata: booking.metadata,
      references: booking.references,
      bookingStatus: booking.status,
      enabledPlatforms: this.deps.config.enabledPlatforms,
    });
    if (!eligibility.eligible) return eligibility;

    if (booking.choice?.rejoinBlocked === true) {
      return { eligible: false, platform: eligibility.platform, reason: "REJOIN_BLOCKED" };
    }

    if (this.hasEnded(booking, now)) {
      return { eligible: false, platform: eligibility.platform, reason: "MEETING_ENDED" };
    }
    return eligibility;
  }

  // A cancelled or rejected booking reads as switched off; the stored row is left as it is.
  private getEffectiveChoice(booking: NotetakerBookingContext): BookingNotetakerRecord | null {
    const choice = booking.choice;
    if (!choice) return null;
    if (booking.status !== "CANCELLED" && booking.status !== "REJECTED") return choice;
    return { ...choice, enabled: false, pendingDispatch: false };
  }

  private async findUserName(userId: number): Promise<string | null> {
    const users = await this.deps.userRepository.findByIds({ ids: [userId] });
    return users.find((user) => user.id === userId)?.name ?? null;
  }

  private async writeDisabledChoice(params: {
    booking: NotetakerBookingContext;
    userId: number;
    now: Date;
  }): Promise<void> {
    const { booking, userId, now } = params;

    // Looked up before the write: the two writes share no transaction, so nothing that can fail sits between them.
    const actorName = await this.findUserName(userId);

    // upsert rather than disable(): disable() cannot record who turned it off. Omitting
    // notifiedAttendeeEmails keeps the list, so people already told are not notified again.
    await this.deps.bookingNotetakerRepository.upsert({
      bookingId: booking.id,
      enabled: false,
      pendingDispatch: false,
      source: "HOST",
      appliedToSeries: false,
      setByUserId: userId,
      setAt: now,
    });

    await this.createActivity({ bookingId: booking.id, action: "DISABLED", userId, actorName });
  }

  private async createActivity(params: {
    bookingId: number;
    action: "ENABLED" | "DISABLED";
    userId: number;
    actorName: string | null;
  }): Promise<void> {
    const { bookingId, action, userId, actorName } = params;

    await this.deps.activityRepository.create({
      bookingId,
      sessionId: null,
      action,
      actorType: "USER",
      actorUserId: userId,
      actorName,
      detail: null,
    });
  }
}
