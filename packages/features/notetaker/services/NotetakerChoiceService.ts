import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { IFeaturesRepository } from "@calcom/features/flags/features.repository.interface";
import type {
  NotetakerDisclosureDto,
  NotetakerEventTypeDefaultDto,
  NotetakerSessionStatusDto,
  NotetakerStateDto,
} from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerTranscriptDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { NotetakerConfig } from "../lib/config";
import { isNotetakerBotProviderUsable } from "../lib/config";
import { getBookingNotetakerEligibility, getEventTypeNotetakerAvailability } from "../lib/eligibility";
import { parseEventTypeLocations } from "../lib/eventTypeLocations";
import { getDisplayedStatus } from "../lib/sessionStateMachine";
import { toNotetakerSummaryDto } from "../lib/summaryDto";
import type { INotetakerTasker } from "../lib/tasker/types";
import type { INotetakerUserLookup } from "../lib/userLookup";
import type {
  BookingNotetakerRecord,
  IBookingNotetakerRepository,
  NotetakerBookingContext,
  NotetakerSeriesBookingRecord,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type {
  IEventTypeNotetakerSettingsRepository,
  NotetakerEventTypeContext,
} from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";
import type { INotetakerActivityRepository } from "../repositories/interfaces/INotetakerActivityRepository";
import type {
  INotetakerSessionRepository,
  NotetakerSessionRecord,
} from "../repositories/interfaces/INotetakerSessionRepository";
import type { INotetakerSummaryRepository } from "../repositories/interfaces/INotetakerSummaryRepository";
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
    speakerNamesAvailable: transcript.speakerNamesAvailable,
  };
}

export interface INotetakerChoiceServiceDeps {
  bookingNotetakerRepository: IBookingNotetakerRepository;
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
    const { bookingUid, enabled, scope, userId } = params;

    const booking = await this.deps.accessService.assertHost({ bookingUid, userId });
    const now = new Date();
    const existing = booking.choice;
    // Non-null only for a series-wide change: on a non-recurring booking the wider scope means this booking.
    const recurringEventId = scope === "ALL_FUTURE_OCCURRENCES" ? booking.recurringEventId : null;

    if (!enabled) {
      // Turning off stays possible after the end time and on an ineligible booking.
      if (!existing?.enabled && recurringEventId === null) return;

      // Looked up before the write: the two writes share no transaction, so nothing that can fail sits between them.
      const actorName = await this.findUserName(userId);

      if (existing?.enabled) {
        await this.writeDisabledChoice({
          bookingId: booking.id,
          userId,
          actorName,
          now,
          appliedToSeries: recurringEventId !== null,
        });
      }
      if (recurringEventId !== null) {
        await this.disableLaterOccurrences({ booking, recurringEventId, userId, actorName, now });
      }
      return;
    }

    const featureEnabled = await this.isFeatureEnabled(userId);
    const eligibility = this.resolveEligibility(booking, featureEnabled, now);
    if (eligibility.reason !== null) {
      // Only the message reaches the client, so it carries the reason code itself.
      throw ErrorWithCode.Factory.BadRequest(eligibility.reason, { reason: eligibility.reason });
    }

    if (existing?.enabled) {
      if (recurringEventId === null) return;
      const actorName = await this.findUserName(userId);
      await this.extendEnabledChoiceToSeries({ booking, recurringEventId, userId, actorName, now });
      return;
    }

    // Looked up before the write: the two writes share no transaction, so nothing that can fail sits between them.
    const actorName = await this.findUserName(userId);

    const won = await this.deps.bookingNotetakerRepository.enableIfDisabled({
      bookingId: booking.id,
      source: "HOST",
      appliedToSeries: recurringEventId !== null,
      setByUserId: userId,
      setAt: now,
    });
    if (!won) {
      const current = await this.deps.bookingNotetakerRepository.findByBookingId(booking.id);
      if (current?.rejoinBlocked === true) {
        throw ErrorWithCode.Factory.BadRequest("REJOIN_BLOCKED", { reason: "REJOIN_BLOCKED" });
      }
      // Another host enabled it first, so this call records no activity and sends no notice.
      if (recurringEventId !== null) {
        await this.extendEnabledChoiceToSeries({ booking, recurringEventId, userId, actorName, now });
      }
      return;
    }

    await this.createActivity({ bookingId: booking.id, action: "ENABLED", userId, actorName });
    // Enqueued before the later occurrences are written, so a failure there cannot lose the notice.
    await this.enqueueAttendeeNotice(booking.id);

    if (recurringEventId !== null) {
      await this.enableLaterOccurrences({ booking, recurringEventId, userId, actorName, now });
    }
  }

  async getState(params: { bookingUid: string; userId: number }): Promise<NotetakerStateDto> {
    const { bookingUid, userId } = params;

    const { role, booking } = await this.deps.accessService.resolveViewerRole({ bookingUid, userId });
    const now = new Date();

    const [featureEnabled, latestSession, latestWithTranscript, sharingGrant] = await Promise.all([
      // A granted attendee reads what a host with the feature shared, so their own flag is not the gate.
      role === "HOST" ? this.isFeatureEnabled(userId) : isNotetakerBotProviderUsable(this.deps.config),
      this.deps.sessionRepository.findLatestByBookingId(booking.id),
      this.deps.sessionRepository.findLatestWithTranscriptByBookingId(booking.id),
      this.deps.bookingNotetakerRepository.findSharingGrant(booking.id),
    ]);

    const isSharedViewer = role === "SHARED_VIEWER";
    // A colleague reads the session the results came from; a later session may have no notice or results.
    const stateSession = isSharedViewer ? (latestWithTranscript?.session ?? null) : latestSession;

    const choice = this.getEffectiveChoice(booking);
    const eligibility = this.resolveEligibility(booking, featureEnabled, now);
    const isHost = role === "HOST";

    const displayedStatus = getDisplayedStatus({
      choice: isSharedViewer ? null : choice,
      latestSessionStatus: stateSession?.status ?? null,
    });
    // "Enabled, not pending, no session" is unreachable by invariant; shown as SCHEDULED rather than as off.
    const status = displayedStatus ?? (choice?.enabled ? "SCHEDULED" : null);

    const transcript =
      latestWithTranscript && latestWithTranscript.session.resultsDeletedAt === null
        ? latestWithTranscript.transcript
        : null;
    const summary = transcript ? await this.deps.summaryRepository.findByTranscriptId(transcript.id) : null;

    if (isSharedViewer && transcript && stateSession) {
      await this.recordFirstSharedView({ bookingId: booking.id, sessionId: stateSession.id, userId });
    }

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
      session: stateSession ? toSessionDto(stateSession) : null,
      transcript: transcript ? toTranscriptDto(transcript) : null,
      summary: summary ? toNotetakerSummaryDto(summary) : null,
      sharedWithAttendees: !isSharedViewer && sharingGrant !== null,
    };
  }

  async getEventTypeDefault(params: {
    eventTypeId: number;
    userId: number;
  }): Promise<NotetakerEventTypeDefaultDto> {
    const { eventTypeId, userId } = params;

    const context = await this.findEventTypeContext(eventTypeId);
    const featureEnabled = await this.isFeatureEnabled(userId);
    const availability = this.getEventTypeAvailability(context);

    return {
      enabledByDefault: context.settings?.enabledByDefault ?? false,
      available: featureEnabled && availability.available,
      unavailableReason: featureEnabled ? availability.unavailableReason : "FEATURE_DISABLED",
    };
  }

  async setEventTypeDefault(params: {
    eventTypeId: number;
    enabledByDefault: boolean;
    userId: number;
  }): Promise<NotetakerEventTypeDefaultDto> {
    const { eventTypeId, enabledByDefault, userId } = params;

    const current = await this.getEventTypeDefault({ eventTypeId, userId });
    if (enabledByDefault && current.unavailableReason !== null) {
      // Only the message reaches the client, so it carries the reason code itself.
      throw ErrorWithCode.Factory.BadRequest(current.unavailableReason, {
        reason: current.unavailableReason,
      });
    }

    await this.deps.eventTypeNotetakerSettingsRepository.upsert({ eventTypeId, enabledByDefault });
    return this.getEventTypeDefault({ eventTypeId, userId });
  }

  async getDisclosure(params: { eventTypeId: number }): Promise<NotetakerDisclosureDto> {
    const context = await this.findEventTypeContext(params.eventTypeId);
    const availability = this.getEventTypeAvailability(context);

    return {
      // No per-user flag here: the booker is anonymous and a team event type has no single owner to check.
      enabledByDefault:
        (context.settings?.enabledByDefault ?? false) && isNotetakerBotProviderUsable(this.deps.config),
      onBehalfOf: context.ownerName,
      supportedLocationTypes: availability.supportedLocationTypes,
    };
  }

  async onBookingCreated(params: { bookingUid: string }): Promise<void> {
    const { bookingUid } = params;

    const booking = await this.deps.bookingNotetakerRepository.findByBookingUidIncludeBooking(bookingUid);
    if (!booking) {
      this.deps.logger.warn("Notetaker booking-created hook found no booking", { bookingUid });
      return;
    }

    const created = await this.applyEventTypeDefault(booking, new Date());
    if (created) await this.enqueueAttendeeNotice(booking.id);
  }

  async onRecurringOccurrenceCreated(params: { bookingUid: string }): Promise<void> {
    const { bookingUid } = params;

    const booking = await this.deps.bookingNotetakerRepository.findByBookingUidIncludeBooking(bookingUid);
    if (!booking) {
      this.deps.logger.warn("Notetaker recurring-occurrence hook found no booking", { bookingUid });
      return;
    }

    const created = await this.applyEventTypeDefault(booking, new Date());
    if (!created) return;

    if (booking.recurringEventId === null) {
      await this.enqueueAttendeeNotice(booking.id);
      return;
    }

    // Occurrences are created one after another, so the first to inherit sends the one notice for the series.
    const rows = await this.deps.bookingNotetakerRepository.findByRecurringEventIdFromStartTime({
      recurringEventId: booking.recurringEventId,
      startTimeGte: new Date(0),
    });
    if (rows.every((row) => row.bookingId === booking.id || row.choice === null)) {
      await this.enqueueAttendeeNotice(booking.id);
    }
  }

  async onBookingRescheduled(params: { bookingUid: string; oldBookingUid: string }): Promise<void> {
    const { bookingUid, oldBookingUid } = params;

    const booking = await this.deps.bookingNotetakerRepository.findByBookingUidIncludeBooking(bookingUid);
    if (!booking) {
      this.deps.logger.warn("Notetaker booking-rescheduled hook found no booking", { bookingUid });
      return;
    }
    if (booking.choice !== null) return;

    const old = await this.deps.bookingNotetakerRepository.findByBookingUidIncludeBooking(oldBookingUid);
    if (!old?.choice) {
      const created = await this.applyEventTypeDefault(booking, new Date());
      if (created) await this.enqueueAttendeeNotice(booking.id);
      return;
    }

    // rejoinBlocked is left behind: the rescheduled booking is a new meeting. The notified list travels
    // with the row, so no notice is enqueued here and dispatch tells only the people not yet told.
    await this.deps.bookingNotetakerRepository.upsert({
      bookingId: booking.id,
      enabled: old.choice.enabled,
      pendingDispatch: old.choice.enabled,
      source: old.choice.source,
      appliedToSeries: old.choice.appliedToSeries,
      setByUserId: old.choice.setByUserId,
      setAt: old.choice.setAt,
      notifiedAttendeeEmails: old.choice.notifiedAttendeeEmails,
    });
    if (!old.choice.enabled) return;

    await this.createSystemActivity({
      bookingId: booking.id,
      action: "ENABLED",
      detail: { source: "RESCHEDULE", fromBookingUid: oldBookingUid },
    });
  }

  async onBookingLocationChanged(params: { bookingId: number }): Promise<{ turnedOff: boolean }> {
    const { bookingId } = params;

    const booking = await this.deps.bookingNotetakerRepository.findByBookingIdIncludeBooking(bookingId);
    if (!booking) {
      this.deps.logger.warn("Notetaker location-changed hook found no booking", { bookingId });
      return { turnedOff: false };
    }
    if (booking.choice?.enabled !== true) return { turnedOff: false };

    // Not resolveEligibility: the feature flag and the end time are not facts about the location.
    const eligibility = getBookingNotetakerEligibility({
      location: booking.location,
      metadata: booking.metadata,
      references: booking.references,
      bookingStatus: booking.status,
      enabledPlatforms: this.deps.config.enabledPlatforms,
    });
    if (eligibility.eligible) return { turnedOff: false };
    // A pending link is still a supported location, and an inactive booking is voided by the sweep.
    if (eligibility.reason === "NO_MEETING_LINK" || eligibility.reason === "BOOKING_NOT_ACTIVE") {
      return { turnedOff: false };
    }

    const flipped = await this.deps.bookingNotetakerRepository.disableIfEnabled(booking.id);
    if (!flipped) return { turnedOff: false };

    await this.createSystemActivity({
      bookingId: booking.id,
      action: "DISABLED",
      detail: { reason: "UNSUPPORTED_LOCATION" },
    });

    const result = await this.deps.notetakerTasker.sendNotification({
      kind: "TURNED_OFF",
      bookingId: booking.id,
      sessionId: null,
    });
    if (result.runId === "task-failed") {
      // The choice is already off and the activity recorded; only the organizer's email is lost.
      this.deps.logger.error("Failed to enqueue the notetaker turned-off notice", { bookingId: booking.id });
    }
    return { turnedOff: true };
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
    bookingId: number;
    userId: number;
    actorName: string | null;
    now: Date;
    appliedToSeries: boolean;
  }): Promise<void> {
    const { bookingId, userId, actorName, now, appliedToSeries } = params;

    // upsert rather than disable(): disable() cannot record who turned it off. Omitting
    // notifiedAttendeeEmails keeps the list, so people already told are not notified again.
    await this.deps.bookingNotetakerRepository.upsert({
      bookingId,
      enabled: false,
      pendingDispatch: false,
      source: "HOST",
      appliedToSeries,
      setByUserId: userId,
      setAt: now,
    });

    await this.createActivity({ bookingId, action: "DISABLED", userId, actorName });
  }

  // Awaited and not swallowed: a view that cannot be recorded is not served. Two concurrent first
  // views may write two rows; the activity feed collapses them.
  private async recordFirstSharedView(params: {
    bookingId: number;
    sessionId: string;
    userId: number;
  }): Promise<void> {
    const { bookingId, sessionId, userId } = params;

    const alreadyViewed = await this.deps.activityRepository.existsByBookingIdAndActionAndActorUserId({
      bookingId,
      action: "SHARED_VIEWED",
      actorUserId: userId,
    });
    if (alreadyViewed) return;

    await this.deps.activityRepository.create({
      bookingId,
      sessionId,
      action: "SHARED_VIEWED",
      actorType: "USER",
      actorUserId: userId,
      actorName: await this.findUserName(userId),
      detail: null,
    });
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

  private async createSystemActivity(params: {
    bookingId: number;
    action: "ENABLED" | "DISABLED";
    detail: Record<string, unknown>;
  }): Promise<void> {
    const { bookingId, action, detail } = params;

    await this.deps.activityRepository.create({
      bookingId,
      sessionId: null,
      action,
      actorType: "SYSTEM",
      actorUserId: null,
      actorName: null,
      detail,
    });
  }

  private async enqueueAttendeeNotice(bookingId: number): Promise<void> {
    const result = await this.deps.notetakerTasker.sendNotification({
      kind: "ATTENDEE_NOTICE",
      bookingId,
      sessionId: null,
    });
    if (result.runId === "task-failed") {
      // The choice is stored, and the notice sent at dispatch time is the catch-all, so the host is not failed.
      this.deps.logger.error("Failed to enqueue the notetaker attendee notice", { bookingId });
    }
  }

  private async findEventTypeContext(eventTypeId: number): Promise<NotetakerEventTypeContext> {
    const context =
      await this.deps.eventTypeNotetakerSettingsRepository.findByEventTypeIdIncludeEventType(eventTypeId);
    if (!context) throw ErrorWithCode.Factory.NotFound("EVENT_TYPE_NOT_FOUND");
    return context;
  }

  private getEventTypeAvailability(
    context: NotetakerEventTypeContext
  ): ReturnType<typeof getEventTypeNotetakerAvailability> {
    return getEventTypeNotetakerAvailability({
      locations: parseEventTypeLocations(context.locations),
      enabledPlatforms: this.deps.config.enabledPlatforms,
    });
  }

  private async applyEventTypeDefault(booking: NotetakerBookingContext, now: Date): Promise<boolean> {
    if (booking.eventTypeId === null) return false;
    // A replayed hook or an earlier host choice must not be overridden.
    if (booking.choice !== null) return false;

    const settings = await this.deps.eventTypeNotetakerSettingsRepository.findByEventTypeId(
      booking.eventTypeId
    );
    if (settings?.enabledByDefault !== true) return false;

    if (booking.userId === null) return false;
    // The flag may have been turned off since the default was set.
    if (!(await this.isFeatureEnabled(booking.userId))) return false;
    if (!this.resolveEligibility(booking, true, now).eligible) return false;

    const won = await this.deps.bookingNotetakerRepository.enableIfDisabled({
      bookingId: booking.id,
      source: "EVENT_TYPE_DEFAULT",
      appliedToSeries: false,
      setByUserId: null,
      setAt: now,
    });
    if (!won) return false;

    await this.createSystemActivity({
      bookingId: booking.id,
      action: "ENABLED",
      detail: { source: "EVENT_TYPE_DEFAULT" },
    });
    return true;
  }

  private async findLaterOccurrences(params: {
    booking: NotetakerBookingContext;
    recurringEventId: string;
    now: Date;
  }): Promise<NotetakerSeriesBookingRecord[]> {
    const { booking, recurringEventId, now } = params;

    const rows = await this.deps.bookingNotetakerRepository.findByRecurringEventIdFromStartTime({
      recurringEventId,
      startTimeGte: booking.startTime,
    });
    // The repository returns every status; what counts as a live occurrence is decided here.
    return rows.filter(
      (row) =>
        row.bookingId !== booking.id &&
        row.status !== "CANCELLED" &&
        row.status !== "REJECTED" &&
        row.endTime.getTime() > now.getTime()
    );
  }

  // For a booking whose choice is already on: no activity and no notice for it, only the series flag.
  private async extendEnabledChoiceToSeries(params: {
    booking: NotetakerBookingContext;
    recurringEventId: string;
    userId: number;
    actorName: string | null;
    now: Date;
  }): Promise<void> {
    await this.deps.bookingNotetakerRepository.setAppliedToSeries(params.booking.id, true);
    await this.enableLaterOccurrences(params);
  }

  private async enableLaterOccurrences(params: {
    booking: NotetakerBookingContext;
    recurringEventId: string;
    userId: number;
    actorName: string | null;
    now: Date;
  }): Promise<void> {
    const { booking, recurringEventId, userId, actorName, now } = params;

    const rows = await this.findLaterOccurrences({ booking, recurringEventId, now });
    for (const row of rows) {
      if (row.choice?.rejoinBlocked === true) continue;
      if (row.choice?.enabled === true) {
        await this.deps.bookingNotetakerRepository.setAppliedToSeries(row.bookingId, true);
        continue;
      }

      const won = await this.deps.bookingNotetakerRepository.enableIfDisabled({
        bookingId: row.bookingId,
        source: "HOST",
        appliedToSeries: true,
        setByUserId: userId,
        setAt: now,
      });
      if (won) await this.createActivity({ bookingId: row.bookingId, action: "ENABLED", userId, actorName });
    }
  }

  private async disableLaterOccurrences(params: {
    booking: NotetakerBookingContext;
    recurringEventId: string;
    userId: number;
    actorName: string | null;
    now: Date;
  }): Promise<void> {
    const { booking, recurringEventId, userId, actorName, now } = params;

    const rows = await this.findLaterOccurrences({ booking, recurringEventId, now });
    for (const row of rows) {
      if (row.choice?.enabled !== true) continue;
      await this.writeDisabledChoice({
        bookingId: row.bookingId,
        userId,
        actorName,
        now,
        appliedToSeries: true,
      });
    }
  }
}
