import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { IFeaturesRepository } from "@calcom/features/flags/features.repository.interface";
import { getTranslation } from "@calcom/i18n/server";
import { ErrorWithCode } from "@calcom/lib/errors";
import short from "short-uuid";
import type {
  INotetakerCalendarEventsGatewayResolver,
  NotetakerAutoJoinCalendarRecord,
} from "../calendar/INotetakerCalendarEventsGateway";
import { NOTETAKER_AD_HOC_SHARING_TEAM_KEY } from "../lib/adHocMeeting";
import type { NotetakerCalendarEvent } from "../lib/calendarMeeting";
import { decideCalendarEvent, NOTETAKER_CALENDAR_MEETING_KEY } from "../lib/calendarMeeting";
import type { NotetakerConfig } from "../lib/config";
import { isNotetakerBotProviderUsable } from "../lib/config";
import type { MeetingContact } from "../lib/meetingContacts";
import { MAX_CALENDAR_CONTACTS, normalizeMeetingContacts } from "../lib/meetingContacts";
import type { INotetakerUserLookup, NotetakerUserRecord } from "../lib/userLookup";
import type { IBookingNotetakerRepository } from "../repositories/interfaces/IBookingNotetakerRepository";
import type { INotetakerCalendarAutoJoinRepository } from "../repositories/interfaces/INotetakerCalendarAutoJoinRepository";
import type {
  INotetakerCalendarMeetingRepository,
  NotetakerCalDiyBookingMatchRecord,
  NotetakerCalendarMeetingRecord,
} from "../repositories/interfaces/INotetakerCalendarMeetingRepository";
import type { INotetakerMeetingContactRepository } from "../repositories/interfaces/INotetakerMeetingContactRepository";

const NOTETAKER_FEATURE_SLUG = "notetaker";
const CALENDAR_AUTO_JOIN_FEATURE_SLUG = "notetaker-calendar-auto-join";
const translator = short();
const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;
const DAY_MS = 24 * HOUR_MS;
const POLL_CONCURRENCY = 5;
// The sweep that runs the poll is killed after 55 s; calendars still queued when the budget runs out wait for the next run.
const POLL_TIME_BUDGET_MS = 40 * SECOND_MS;
const MAX_POLL_ERROR_LENGTH = 500;

type MeetingTarget = {
  meetingKey: string;
  meetingUrl: string;
  startTime: Date;
  endTime: Date;
};

type SyncContext = {
  calendar: NotetakerAutoJoinCalendarRecord;
  user: NotetakerUserRecord;
  now: Date;
  windowEnd: Date;
  selfEmails: string[];
  seenEventIds: Set<string>;
  counts: NotetakerCalendarSyncCounts;
  defaultTitle: string | null;
};

function emptySyncCounts(): NotetakerCalendarSyncCounts {
  return { created: 0, joined: 0, removed: 0, enabledBookings: 0 };
}

function addSyncCounts(target: NotetakerCalendarSyncCounts, source: NotetakerCalendarSyncCounts): void {
  target.created += source.created;
  target.joined += source.joined;
  target.removed += source.removed;
  target.enabledBookings += source.enabledBookings;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameInstant(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

function activeParticipantsExcept(meeting: NotetakerCalendarMeetingRecord, userId: number) {
  return meeting.participants.filter((p) => p.userId !== userId && p.removedAt === null);
}

function calendarEventContacts(event: NotetakerCalendarEvent): MeetingContact[] {
  const contacts = event.attendees ?? event.attendeeEmails.map((email) => ({ email, name: null }));
  return event.organizerEmail ? [...contacts, { email: event.organizerEmail, name: null }] : contacts;
}

function hasActiveParticipant(meeting: NotetakerCalendarMeetingRecord, userId: number): boolean {
  return meeting.participants.some((p) => p.userId === userId && p.removedAt === null);
}

export type NotetakerCalendarSyncCounts = {
  created: number;
  joined: number;
  removed: number;
  enabledBookings: number;
};

export type NotetakerCalendarPollCounts = NotetakerCalendarSyncCounts & {
  calendarsPolled: number;
  failed: number;
};

export interface INotetakerCalendarAutoJoinServiceDeps {
  autoJoinRepository: Pick<INotetakerCalendarAutoJoinRepository, "findDueForPoll" | "markPolled">;
  calendarMeetingRepository: Omit<INotetakerCalendarMeetingRepository, "isParticipant">;
  meetingContactRepository: Pick<INotetakerMeetingContactRepository, "replaceForSource">;
  bookingNotetakerRepository: Pick<IBookingNotetakerRepository, "findVerifiedEmailsByUserId">;
  eventsGatewayResolver: INotetakerCalendarEventsGatewayResolver;
  featuresRepository: Pick<IFeaturesRepository, "checkIfUserHasFeature">;
  userRepository: INotetakerUserLookup;
  config: NotetakerConfig;
  logger: ISimpleLogger;
}

export class NotetakerCalendarAutoJoinService {
  constructor(private readonly deps: INotetakerCalendarAutoJoinServiceDeps) {}

  async pollDue(now: Date = new Date()): Promise<NotetakerCalendarPollCounts> {
    const { autoJoinRepository, eventsGatewayResolver, config, logger } = this.deps;
    const counts: NotetakerCalendarPollCounts = { ...emptySyncCounts(), calendarsPolled: 0, failed: 0 };
    if (!isNotetakerBotProviderUsable(config)) return counts;

    const { pollIntervalSeconds, pollBatchSize } = config.calendarAutoJoin;
    const calendars = await autoJoinRepository.findDueForPoll({
      polledBefore: new Date(now.getTime() - pollIntervalSeconds * SECOND_MS),
      integrations: eventsGatewayResolver.supportedIntegrations(),
      limit: pollBatchSize,
    });
    if (calendars.length === 0) return counts;

    const startedAt = Date.now();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < calendars.length) {
        if (Date.now() - startedAt >= POLL_TIME_BUDGET_MS) return;
        const calendar = calendars[next];
        next += 1;
        await this.pollCalendar(calendar, now, counts);
      }
    };
    await Promise.all(Array.from({ length: Math.min(POLL_CONCURRENCY, calendars.length) }, worker));

    if (next < calendars.length) {
      logger.warn("Notetaker calendar poll stopped at its time budget", {
        polled: next,
        remaining: calendars.length - next,
      });
    }
    return counts;
  }

  async syncCalendar(
    calendar: NotetakerAutoJoinCalendarRecord,
    now: Date
  ): Promise<NotetakerCalendarSyncCounts> {
    const { eventsGatewayResolver, userRepository, config } = this.deps;
    const gateway = eventsGatewayResolver.resolve(calendar.integration);
    if (!gateway) {
      throw ErrorWithCode.Factory.BadRequest(
        `No notetaker events gateway for integration ${calendar.integration} of selected calendar ${calendar.selectedCalendarId}`
      );
    }
    const [user] = await userRepository.findByIds({ ids: [calendar.userId] });
    if (!user) {
      throw ErrorWithCode.Factory.NotFound(
        `User ${calendar.userId} of selected calendar ${calendar.selectedCalendarId} not found`
      );
    }

    const windowEnd = new Date(now.getTime() + config.calendarAutoJoin.lookaheadHours * HOUR_MS);
    const events = await gateway.listEvents({ calendar, timeMin: now, timeMax: windowEnd });
    const ctx: SyncContext = {
      calendar,
      user,
      now,
      windowEnd,
      selfEmails: [user.email.toLowerCase()],
      seenEventIds: new Set(),
      counts: emptySyncCounts(),
      defaultTitle: null,
    };
    for (const event of events) {
      ctx.seenEventIds.add(event.externalId);
      await this.syncEvent(ctx, event);
    }
    await this.removeDisappeared(ctx);
    return ctx.counts;
  }

  private async pollCalendar(
    calendar: NotetakerAutoJoinCalendarRecord,
    now: Date,
    counts: NotetakerCalendarPollCounts
  ): Promise<void> {
    const { autoJoinRepository, logger } = this.deps;
    const { selectedCalendarId, userId } = calendar;
    try {
      if (!(await this.hasAutoJoinFeature(userId))) {
        logger.info("Notetaker calendar auto-join skipped: feature not enabled for user", {
          selectedCalendarId,
          userId,
        });
        await autoJoinRepository.markPolled({ selectedCalendarId, at: now, error: null });
        return;
      }
      const synced = await this.syncCalendar(calendar, now);
      counts.calendarsPolled += 1;
      addSyncCounts(counts, synced);
      await autoJoinRepository.markPolled({ selectedCalendarId, at: now, error: null });
    } catch (error) {
      counts.calendarsPolled += 1;
      counts.failed += 1;
      const message = errorMessage(error);
      logger.error("Notetaker calendar sync failed", { selectedCalendarId, userId, error: message });
      try {
        await autoJoinRepository.markPolled({
          selectedCalendarId,
          at: now,
          error: message.slice(0, MAX_POLL_ERROR_LENGTH),
        });
      } catch (markError) {
        logger.error("Notetaker calendar poll error could not be recorded", {
          selectedCalendarId,
          error: errorMessage(markError),
        });
      }
    }
  }

  private async hasAutoJoinFeature(userId: number): Promise<boolean> {
    const { featuresRepository } = this.deps;
    if (!(await featuresRepository.checkIfUserHasFeature(userId, NOTETAKER_FEATURE_SLUG))) return false;
    return featuresRepository.checkIfUserHasFeature(userId, CALENDAR_AUTO_JOIN_FEATURE_SLUG);
  }

  private async syncEvent(ctx: SyncContext, event: NotetakerCalendarEvent): Promise<void> {
    const { calendarMeetingRepository, config, logger } = this.deps;
    const { calendar, now } = ctx;
    const decision = decideCalendarEvent(event, {
      now,
      enabledPlatforms: config.enabledPlatforms,
      selfEmails: ctx.selfEmails,
    });

    const calDiyBooking = await calendarMeetingRepository.findCalDiyBookingForEvent({
      iCalUID: event.iCalUID,
      externalEventId: event.externalId,
    });
    if (calDiyBooking) {
      if (decision.join) await this.syncCalDiyBooking(ctx, calDiyBooking);
      return;
    }

    const existing = await calendarMeetingRepository.findByParticipantEvent({
      selectedCalendarId: calendar.selectedCalendarId,
      externalEventId: event.externalId,
    });
    if (!decision.join) {
      if (existing && hasActiveParticipant(existing, calendar.userId)) {
        logger.info("Notetaker calendar event no longer qualifies; participant leaves the meeting", {
          meetingId: existing.id,
          selectedCalendarId: calendar.selectedCalendarId,
          reason: decision.reason,
        });
        await this.removeParticipant(ctx, existing);
      }
      return;
    }

    const target: MeetingTarget = {
      meetingKey: decision.meetingKey,
      meetingUrl: decision.meetingUrl,
      startTime: event.start,
      endTime: this.clampEndTime(event),
    };
    if (existing) {
      await this.reconcileExisting(ctx, existing, event, target);
      return;
    }
    await this.joinOrCreate(ctx, event, target);
  }

  // The host's own booking gets the bot directly; a separate calendar meeting would send a second one.
  private async syncCalDiyBooking(
    ctx: SyncContext,
    booking: NotetakerCalDiyBookingMatchRecord
  ): Promise<void> {
    const { calendarMeetingRepository, logger } = this.deps;
    if (booking.hasNotetakerChoice || booking.hostUserId !== ctx.calendar.userId) return;
    const enabled = await calendarMeetingRepository.enableChoiceForCalendarAutoJoin({
      bookingId: booking.bookingId,
    });
    if (!enabled) return;
    ctx.counts.enabledBookings += 1;
    logger.info("Notetaker enabled on Cal.diy booking found in calendar", {
      bookingId: booking.bookingId,
      selectedCalendarId: ctx.calendar.selectedCalendarId,
    });
  }

  private async reconcileExisting(
    ctx: SyncContext,
    existing: NotetakerCalendarMeetingRecord,
    event: NotetakerCalendarEvent,
    target: MeetingTarget
  ): Promise<void> {
    const { calendarMeetingRepository, logger } = this.deps;
    const { calendar, now } = ctx;
    const userId = calendar.userId;
    const participantActive = hasActiveParticipant(existing, userId);
    const others = activeParticipantsExcept(existing, userId);
    const unchanged =
      existing.meetingKey === target.meetingKey &&
      sameInstant(existing.startTime, target.startTime) &&
      sameInstant(existing.endTime, target.endTime);

    if (!participantActive) {
      // The user left this meeting earlier (declined, or the event vanished) and the event qualifies again.
      if (others.length > 0 && unchanged) {
        await this.joinMeeting(ctx, existing, event);
        return;
      }
      await this.joinOrCreate(ctx, event, target);
      return;
    }

    if (unchanged || existing.hasSession) {
      if (!unchanged) {
        logger.info("Notetaker calendar meeting changed after its session started; left as is", {
          meetingId: existing.id,
          selectedCalendarId: calendar.selectedCalendarId,
        });
      }
      await calendarMeetingRepository.touchParticipant({ meetingId: existing.id, userId, seenAt: now });
      await this.storeCalendarContacts(ctx, existing, event);
      return;
    }

    if (others.length > 0) {
      // The other participants still meet at the old link and time, so only this user moves.
      await this.removeParticipant(ctx, existing);
      await this.joinOrCreate(ctx, event, target);
      return;
    }

    const result = await calendarMeetingRepository.reschedule({
      meetingId: existing.id,
      bookingId: existing.bookingId,
      ...target,
    });
    if (result === "OK") {
      logger.info("Notetaker calendar meeting rescheduled", {
        meetingId: existing.id,
        selectedCalendarId: calendar.selectedCalendarId,
      });
      await calendarMeetingRepository.touchParticipant({ meetingId: existing.id, userId, seenAt: now });
      await this.storeCalendarContacts(ctx, { ...existing, endTime: target.endTime }, event);
      return;
    }
    // Another meeting already holds the new link and time, so this user joins it and leaves the old one.
    const other = await calendarMeetingRepository.findByKey({
      meetingKey: target.meetingKey,
      startTime: target.startTime,
    });
    if (!other || other.id === existing.id) {
      logger.warn("Notetaker calendar meeting reschedule conflicted with no meeting to join", {
        meetingId: existing.id,
        selectedCalendarId: calendar.selectedCalendarId,
      });
      return;
    }
    await this.joinMeeting(ctx, other, event);
    await this.removeParticipant(ctx, existing);
  }

  private async joinOrCreate(
    ctx: SyncContext,
    event: NotetakerCalendarEvent,
    target: MeetingTarget
  ): Promise<void> {
    const { calendarMeetingRepository, logger } = this.deps;
    const { calendar, user, now } = ctx;

    const byKey = await calendarMeetingRepository.findByKey({
      meetingKey: target.meetingKey,
      startTime: target.startTime,
    });
    if (byKey) {
      await this.joinMeeting(ctx, byKey, event);
      return;
    }

    if (await this.isDailyCapReached(ctx)) return;

    const result = await calendarMeetingRepository.createWithBooking({
      bookingUid: translator.generate(),
      title: event.title?.trim() || (await this.defaultTitle(ctx)),
      meetingUrl: target.meetingUrl,
      meetingKey: target.meetingKey,
      startTime: target.startTime,
      endTime: target.endTime,
      iCalUID: event.iCalUID,
      metadata: {
        [NOTETAKER_CALENDAR_MEETING_KEY]: "true",
        ...(calendar.sharingTeamId !== null
          ? { [NOTETAKER_AD_HOC_SHARING_TEAM_KEY]: String(calendar.sharingTeamId) }
          : {}),
      },
      owner: {
        userId: user.id,
        email: user.email,
        name: user.name ?? "",
        timeZone: user.timeZone,
        selectedCalendarId: calendar.selectedCalendarId,
        externalEventId: event.externalId,
      },
      seenAt: now,
    });
    if (result !== "CONFLICT") {
      ctx.counts.created += 1;
      logger.info("Notetaker calendar meeting created", {
        meetingId: result.id,
        bookingId: result.bookingId,
        selectedCalendarId: calendar.selectedCalendarId,
      });
      await this.storeCalendarContacts(ctx, result, event);
      return;
    }
    // Another calendar created the same meeting between the lookup and the insert.
    const winner = await calendarMeetingRepository.findByKey({
      meetingKey: target.meetingKey,
      startTime: target.startTime,
    });
    if (!winner) {
      logger.warn("Notetaker calendar meeting creation conflicted with no meeting to join", {
        selectedCalendarId: calendar.selectedCalendarId,
      });
      return;
    }
    await this.joinMeeting(ctx, winner, event);
  }

  private async joinMeeting(
    ctx: SyncContext,
    meeting: NotetakerCalendarMeetingRecord,
    event: NotetakerCalendarEvent
  ): Promise<void> {
    const { calendarMeetingRepository, logger } = this.deps;
    const { calendar, user, now } = ctx;
    if (!meeting.participants.some((p) => p.removedAt === null)) {
      // Once a bot was dispatched the meeting is left as is, even with nobody left in it.
      if (meeting.hasSession) {
        logger.warn("Notetaker calendar meeting has a session and no participants; left as is", {
          meetingId: meeting.id,
          selectedCalendarId: calendar.selectedCalendarId,
        });
        return;
      }
      // The last participant leaving cancelled the booking; a plain join would not bring the bot back.
      await this.reviveMeeting(ctx, meeting, event);
      return;
    }
    await calendarMeetingRepository.upsertParticipant({
      meetingId: meeting.id,
      bookingId: meeting.bookingId,
      userId: user.id,
      email: user.email,
      name: user.name ?? "",
      timeZone: user.timeZone,
      selectedCalendarId: calendar.selectedCalendarId,
      externalEventId: event.externalId,
      seenAt: now,
    });
    ctx.counts.joined += 1;
    logger.info("Notetaker calendar meeting joined", {
      meetingId: meeting.id,
      selectedCalendarId: calendar.selectedCalendarId,
    });
  }

  private async reviveMeeting(
    ctx: SyncContext,
    meeting: NotetakerCalendarMeetingRecord,
    event: NotetakerCalendarEvent
  ): Promise<void> {
    const { calendarMeetingRepository, logger } = this.deps;
    const { calendar, user, now } = ctx;
    if (await this.isDailyCapReached(ctx)) return;
    await calendarMeetingRepository.revive({
      meetingId: meeting.id,
      bookingId: meeting.bookingId,
      userId: user.id,
      email: user.email,
      name: user.name ?? "",
      timeZone: user.timeZone,
      selectedCalendarId: calendar.selectedCalendarId,
      externalEventId: event.externalId,
      seenAt: now,
    });
    ctx.counts.created += 1;
    logger.info("Notetaker calendar meeting revived", {
      meetingId: meeting.id,
      bookingId: meeting.bookingId,
      selectedCalendarId: calendar.selectedCalendarId,
    });
  }

  // Contacts go only to the CRM, never into Attendee rows, which would email them and grant them access.
  private async storeCalendarContacts(
    ctx: SyncContext,
    meeting: NotetakerCalendarMeetingRecord,
    event: NotetakerCalendarEvent
  ): Promise<void> {
    const { meetingContactRepository, logger } = this.deps;
    const { calendar, now } = ctx;
    // Only the owner's calendar feeds the contacts, so participants with differing invites do not overwrite each other.
    if (meeting.ownerUserId !== calendar.userId) return;
    if (meeting.endTime.getTime() <= now.getTime()) return;
    try {
      const excludedEmails = await this.calDiyUserEmails(ctx, meeting, event);
      const contacts = normalizeMeetingContacts(
        calendarEventContacts(event),
        excludedEmails,
        MAX_CALENDAR_CONTACTS
      );
      await meetingContactRepository.replaceForSource({
        bookingId: meeting.bookingId,
        source: "CALENDAR",
        contacts,
      });
    } catch (error) {
      // The error text can carry the emails being written, so only ids are logged.
      logger.warn("Notetaker calendar meeting contacts could not be stored", {
        meetingId: meeting.id,
        bookingId: meeting.bookingId,
        selectedCalendarId: calendar.selectedCalendarId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async calDiyUserEmails(
    ctx: SyncContext,
    meeting: NotetakerCalendarMeetingRecord,
    event: NotetakerCalendarEvent
  ): Promise<string[]> {
    const { bookingNotetakerRepository, userRepository } = this.deps;
    const { user } = ctx;
    const otherUserIds = Array.from(
      new Set(meeting.participants.map((p) => p.userId).filter((id) => id !== user.id))
    );
    const [verifiedEmails, otherUsers] = await Promise.all([
      Promise.all(
        [user.id, ...otherUserIds].map((id) => bookingNotetakerRepository.findVerifiedEmailsByUserId(id))
      ),
      otherUserIds.length > 0 ? userRepository.findByIds({ ids: otherUserIds }) : Promise.resolve([]),
    ]);
    const emails = [user.email, ...verifiedEmails.flat(), ...otherUsers.map((other) => other.email)];
    if (event.selfResponse === "organizer" && event.organizerEmail) emails.push(event.organizerEmail);
    return emails;
  }

  private async isDailyCapReached(ctx: SyncContext): Promise<boolean> {
    const { calendarMeetingRepository, config, logger } = this.deps;
    const { calendar, now } = ctx;
    const createdToday = await calendarMeetingRepository.countCreatedByOwnerSince({
      userId: calendar.userId,
      since: new Date(now.getTime() - DAY_MS),
    });
    if (createdToday < config.calendarAutoJoin.maxMeetingsPerDay) return false;
    logger.warn("Notetaker calendar meeting not created: daily cap reached", {
      userId: calendar.userId,
      selectedCalendarId: calendar.selectedCalendarId,
      createdToday,
    });
    return true;
  }

  private async removeParticipant(ctx: SyncContext, meeting: NotetakerCalendarMeetingRecord): Promise<void> {
    const { calendarMeetingRepository, logger } = this.deps;
    const { calendar, now } = ctx;
    const userId = calendar.userId;
    await calendarMeetingRepository.markParticipantRemoved({ meetingId: meeting.id, userId, at: now });
    // Once a bot was dispatched the meeting runs to its end for whoever is left, so the booking is kept.
    if (meeting.hasSession) return;

    const remaining = activeParticipantsExcept(meeting, userId);
    if (remaining.length === 0) {
      await calendarMeetingRepository.cancel({ meetingId: meeting.id, bookingId: meeting.bookingId });
      ctx.counts.removed += 1;
      logger.info("Notetaker calendar meeting cancelled: last participant left", { meetingId: meeting.id });
      return;
    }
    if (meeting.ownerUserId !== userId) return;
    await calendarMeetingRepository.transferOwner({
      meetingId: meeting.id,
      bookingId: meeting.bookingId,
      userId: remaining[0].userId,
    });
    logger.info("Notetaker calendar meeting owner transferred", {
      meetingId: meeting.id,
      fromUserId: userId,
      toUserId: remaining[0].userId,
    });
  }

  private async removeDisappeared(ctx: SyncContext): Promise<void> {
    const { calendarMeetingRepository, logger } = this.deps;
    const { calendar, now, windowEnd } = ctx;
    const meetings = await calendarMeetingRepository.findActiveByCalendarInRange({
      selectedCalendarId: calendar.selectedCalendarId,
      from: now,
      to: windowEnd,
    });
    for (const meeting of meetings) {
      const participant = meeting.participants.find(
        (p) => p.selectedCalendarId === calendar.selectedCalendarId && p.removedAt === null
      );
      if (!participant || ctx.seenEventIds.has(participant.externalEventId)) continue;
      logger.info("Notetaker calendar event disappeared; participant leaves the meeting", {
        meetingId: meeting.id,
        selectedCalendarId: calendar.selectedCalendarId,
      });
      await this.removeParticipant(ctx, meeting);
    }
  }

  // The bot leaves at the configured limit regardless of the booking, so a longer booking would end empty.
  private clampEndTime(event: NotetakerCalendarEvent): Date {
    const maxEnd = event.start.getTime() + this.deps.config.limits.maxDurationSeconds * SECOND_MS;
    return new Date(Math.min(event.end.getTime(), maxEnd));
  }

  private async defaultTitle(ctx: SyncContext): Promise<string> {
    if (ctx.defaultTitle !== null) return ctx.defaultTitle;
    const t = await getTranslation(ctx.user.locale ?? "en", "common");
    ctx.defaultTitle = t("notetaker_ad_hoc_default_title");
    return ctx.defaultTitle;
  }
}
