import type { NotetakerActivityActionDto } from "@calcom/lib/dto/NotetakerActivityDto";
import type { NotetakerChoiceSourceDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerSummaryStatusDto } from "@calcom/lib/dto/NotetakerSummaryDto";
import type {
  BookingNotetakerRecord,
  IBookingNotetakerRepository,
  NotetakerAttendeeRecord,
  NotetakerBookingContext,
  NotetakerBookingReferenceRecord,
  NotetakerBookingStatus,
  NotetakerSeriesBookingRecord,
  NotetakerSharingGrantRecord,
  NotetakerWebPushSubscriptionRecord,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type {
  EventTypeNotetakerSettingsRecord,
  IEventTypeNotetakerSettingsRepository,
  NotetakerEventTypeContext,
} from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";
import type {
  INotetakerActivityRepository,
  NotetakerActivityRecord,
} from "../repositories/interfaces/INotetakerActivityRepository";
import type {
  INotetakerSessionRepository,
  NotetakerSessionCreateInput,
  NotetakerSessionRecord,
  NotetakerSessionUpdateInput,
} from "../repositories/interfaces/INotetakerSessionRepository";
import type {
  INotetakerSummaryRepository,
  NotetakerSummaryRecord,
} from "../repositories/interfaces/INotetakerSummaryRepository";
import type {
  INotetakerTranscriptRepository,
  NotetakerPassageRecord,
  NotetakerTranscriptRecord,
} from "../repositories/interfaces/INotetakerTranscriptRepository";

type InMemoryBookingSeed = Omit<NotetakerBookingContext, "choice">;
type InMemoryEventTypeSeed = Omit<NotetakerEventTypeContext, "settings">;

function copySeed(seed: InMemoryBookingSeed): InMemoryBookingSeed {
  return {
    ...seed,
    attendeeEmails: [...seed.attendeeEmails],
    references: seed.references.map((reference) => ({ ...reference })),
    eventTypeHosts: seed.eventTypeHosts.map((host) => ({ ...host })),
    organizer: seed.organizer ? { ...seed.organizer } : null,
  };
}

function copyEventTypeSeed(seed: InMemoryEventTypeSeed): InMemoryEventTypeSeed {
  return { ...seed };
}

function copyChoice(choice: BookingNotetakerRecord): BookingNotetakerRecord {
  return { ...choice, notifiedAttendeeEmails: [...choice.notifiedAttendeeEmails] };
}

function copyGrant(grant: NotetakerSharingGrantRecord): NotetakerSharingGrantRecord {
  return { ...grant };
}

function copyAttendee(attendee: NotetakerAttendeeRecord): NotetakerAttendeeRecord {
  return { ...attendee };
}

function copyReference(reference: NotetakerBookingReferenceRecord): NotetakerBookingReferenceRecord {
  return { ...reference };
}

function copySettings(settings: EventTypeNotetakerSettingsRecord): EventTypeNotetakerSettingsRecord {
  return { ...settings };
}

function copySession(session: NotetakerSessionRecord): NotetakerSessionRecord {
  return { ...session };
}

function copyTranscript(transcript: NotetakerTranscriptRecord): NotetakerTranscriptRecord {
  return { ...transcript };
}

function copyPassage(passage: NotetakerPassageRecord): NotetakerPassageRecord {
  return { ...passage };
}

function copySummary(summary: NotetakerSummaryRecord): NotetakerSummaryRecord {
  return {
    ...summary,
    keyPoints: [...summary.keyPoints],
    decisions: [...summary.decisions],
    actionItems: summary.actionItems.map((item) => ({ ...item })),
  };
}

function cloneDetail(detail: NotetakerActivityRecord["detail"]): NotetakerActivityRecord["detail"] {
  if (!detail) return null;
  return JSON.parse(JSON.stringify(detail));
}

function copyActivity(activity: NotetakerActivityRecord): NotetakerActivityRecord {
  return { ...activity, detail: cloneDetail(activity.detail) };
}

// Prisma ignores undefined keys in update data; null still writes null.
function applyDefined<T extends object>(target: T, patch: Partial<T>): void {
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) {
      target[key] = value as T[keyof T];
    }
  }
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareNumbers(a: number, b: number): number {
  return a - b;
}

function compareLatestSessionFirst(a: NotetakerSessionRecord, b: NotetakerSessionRecord): number {
  const byDispatchedAt = b.dispatchedAt.getTime() - a.dispatchedAt.getTime();
  if (byDispatchedAt !== 0) return byDispatchedAt;
  return compareStrings(b.id, a.id);
}

export class InMemoryNotetakerStore {
  readonly bookings = new Map<number, InMemoryBookingSeed>();
  readonly eventTypes = new Map<number, InMemoryEventTypeSeed>();
  readonly verifiedEmails = new Map<number, string[]>();
  readonly attendees = new Map<number, NotetakerAttendeeRecord[]>();
  readonly references = new Map<number, NotetakerBookingReferenceRecord[]>();
  readonly webPushSubscriptions = new Map<number, string[]>();
  readonly choices = new Map<number, BookingNotetakerRecord>();
  readonly sharingGrants = new Map<number, NotetakerSharingGrantRecord>();
  readonly eventTypeSettings = new Map<number, EventTypeNotetakerSettingsRecord>();
  readonly sessions = new Map<string, NotetakerSessionRecord>();
  readonly transcripts = new Map<string, NotetakerTranscriptRecord>();
  readonly passages = new Map<string, Map<number, NotetakerPassageRecord>>();
  readonly summaries = new Map<string, NotetakerSummaryRecord>();
  readonly activities: NotetakerActivityRecord[] = [];

  private idCounter = 0;

  // The interfaces tie-break on `id desc`. Under a fixed clock random uuids would make "latest"
  // non-deterministic; increasing ids make the latest-created row win.
  nextId(): string {
    this.idCounter += 1;
    return `00000000-0000-4000-8000-${String(this.idCounter).padStart(12, "0")}`;
  }

  addBooking(booking: InMemoryBookingSeed): void {
    this.bookings.set(booking.id, copySeed(booking));
  }

  removeBooking(bookingId: number): void {
    this.bookings.delete(bookingId);
    this.choices.delete(bookingId);
    this.sharingGrants.delete(bookingId);
    this.attendees.delete(bookingId);
    this.references.delete(bookingId);

    const sessionIds = new Set<string>();
    for (const session of Array.from(this.sessions.values())) {
      if (session.bookingId === bookingId) sessionIds.add(session.id);
    }
    for (const sessionId of Array.from(sessionIds)) {
      this.sessions.delete(sessionId);
    }

    const transcriptIds: string[] = [];
    for (const transcript of Array.from(this.transcripts.values())) {
      if (transcript.bookingId === bookingId || sessionIds.has(transcript.sessionId)) {
        transcriptIds.push(transcript.id);
      }
    }
    for (const transcriptId of transcriptIds) {
      this.removeTranscript(transcriptId);
    }

    for (let i = this.activities.length - 1; i >= 0; i -= 1) {
      if (this.activities[i].bookingId === bookingId) this.activities.splice(i, 1);
    }
  }

  addEventType(eventType: InMemoryEventTypeSeed): void {
    this.eventTypes.set(eventType.id, copyEventTypeSeed(eventType));
  }

  setVerifiedEmails(userId: number, emails: string[]): void {
    this.verifiedEmails.set(userId, [...emails]);
  }

  setAttendees(bookingId: number, attendees: NotetakerAttendeeRecord[]): void {
    this.attendees.set(bookingId, attendees.map(copyAttendee));
  }

  setReferences(bookingId: number, references: NotetakerBookingReferenceRecord[]): void {
    this.references.set(bookingId, references.map(copyReference));
  }

  setWebPushSubscriptions(userId: number, subscriptions: string[]): void {
    this.webPushSubscriptions.set(userId, [...subscriptions]);
  }

  removeTranscript(transcriptId: string): void {
    this.transcripts.delete(transcriptId);
    this.passages.delete(transcriptId);
    this.summaries.delete(transcriptId);
  }
}

export class InMemoryBookingNotetakerRepository implements IBookingNotetakerRepository {
  constructor(private readonly store: InMemoryNotetakerStore) {}

  private toContext(seed: InMemoryBookingSeed): NotetakerBookingContext {
    const choice = this.store.choices.get(seed.id);
    return { ...copySeed(seed), choice: choice ? copyChoice(choice) : null };
  }

  private bookingsByRecurringEventId(recurringEventId: string): InMemoryBookingSeed[] {
    return Array.from(this.store.bookings.values())
      .filter((booking) => booking.recurringEventId === recurringEventId)
      .sort((a, b) => compareNumbers(a.id, b.id));
  }

  async findByBookingId(bookingId: number): Promise<BookingNotetakerRecord | null> {
    const choice = this.store.choices.get(bookingId);
    return choice ? copyChoice(choice) : null;
  }

  async findByBookingUidIncludeBooking(bookingUid: string): Promise<NotetakerBookingContext | null> {
    for (const seed of Array.from(this.store.bookings.values())) {
      if (seed.uid === bookingUid) return this.toContext(seed);
    }
    return null;
  }

  async findByBookingIdIncludeBooking(bookingId: number): Promise<NotetakerBookingContext | null> {
    const seed = this.store.bookings.get(bookingId);
    return seed ? this.toContext(seed) : null;
  }

  async upsert(data: {
    bookingId: number;
    enabled: boolean;
    pendingDispatch: boolean;
    source: NotetakerChoiceSourceDto;
    appliedToSeries: boolean;
    setByUserId: number | null;
    setAt: Date;
    notifiedAttendeeEmails?: string[];
  }): Promise<BookingNotetakerRecord> {
    if (!this.store.bookings.has(data.bookingId)) {
      throw new Error(`InMemoryNotetakerStore: booking ${data.bookingId} does not exist`);
    }
    const existing = this.store.choices.get(data.bookingId);
    if (!existing) {
      const created: BookingNotetakerRecord = {
        bookingId: data.bookingId,
        enabled: data.enabled,
        pendingDispatch: data.pendingDispatch,
        source: data.source,
        appliedToSeries: data.appliedToSeries,
        rejoinBlocked: false,
        setByUserId: data.setByUserId,
        setAt: data.setAt,
        attendeesNotifiedAt: null,
        notifiedAttendeeEmails: [...(data.notifiedAttendeeEmails ?? [])],
      };
      this.store.choices.set(data.bookingId, created);
      return copyChoice(created);
    }
    existing.enabled = data.enabled;
    existing.pendingDispatch = data.pendingDispatch;
    existing.source = data.source;
    existing.appliedToSeries = data.appliedToSeries;
    existing.setByUserId = data.setByUserId;
    existing.setAt = data.setAt;
    if (data.notifiedAttendeeEmails !== undefined) {
      existing.notifiedAttendeeEmails = [...data.notifiedAttendeeEmails];
    }
    return copyChoice(existing);
  }

  // No await before the write: the check and the mutation must be one synchronous step so
  // concurrent callers cannot both win, mirroring the conditional update in the Prisma repository.
  async enableIfDisabled(data: {
    bookingId: number;
    source: NotetakerChoiceSourceDto;
    appliedToSeries: boolean;
    setByUserId: number | null;
    setAt: Date;
  }): Promise<boolean> {
    if (!this.store.bookings.has(data.bookingId)) {
      throw new Error(`InMemoryNotetakerStore: booking ${data.bookingId} does not exist`);
    }
    const existing = this.store.choices.get(data.bookingId);
    if (!existing) {
      this.store.choices.set(data.bookingId, {
        bookingId: data.bookingId,
        enabled: true,
        pendingDispatch: true,
        source: data.source,
        appliedToSeries: data.appliedToSeries,
        rejoinBlocked: false,
        setByUserId: data.setByUserId,
        setAt: data.setAt,
        attendeesNotifiedAt: null,
        notifiedAttendeeEmails: [],
      });
      return true;
    }
    if (existing.enabled || existing.rejoinBlocked) return false;
    existing.enabled = true;
    existing.pendingDispatch = true;
    existing.source = data.source;
    existing.appliedToSeries = data.appliedToSeries;
    existing.setByUserId = data.setByUserId;
    existing.setAt = data.setAt;
    return true;
  }

  async disable(bookingId: number): Promise<void> {
    const choice = this.store.choices.get(bookingId);
    if (!choice) return;
    choice.enabled = false;
    choice.pendingDispatch = false;
  }

  // No await before the write, as in enableIfDisabled: concurrent callers must not both win.
  async disableIfEnabled(bookingId: number): Promise<boolean> {
    const choice = this.store.choices.get(bookingId);
    if (!choice || !choice.enabled) return false;
    choice.enabled = false;
    choice.pendingDispatch = false;
    return true;
  }

  async clearPendingDispatch(bookingId: number): Promise<boolean> {
    const choice = this.store.choices.get(bookingId);
    if (!choice || !choice.pendingDispatch) return false;
    choice.pendingDispatch = false;
    return true;
  }

  async setPendingDispatch(bookingId: number, pendingDispatch: boolean): Promise<void> {
    const choice = this.store.choices.get(bookingId);
    if (!choice) return;
    choice.pendingDispatch = pendingDispatch;
  }

  async setRejoinBlocked(bookingId: number, rejoinBlocked: boolean): Promise<void> {
    const choice = this.store.choices.get(bookingId);
    if (!choice) return;
    choice.rejoinBlocked = rejoinBlocked;
  }

  async findEnabledIncludeBooking(params: {
    bookingStatuses: NotetakerBookingStatus[];
    startTimeLte: Date;
    endTimeGt?: Date;
    pendingDispatch?: boolean;
    limit: number;
  }): Promise<NotetakerBookingContext[]> {
    const matches: InMemoryBookingSeed[] = [];
    for (const choice of Array.from(this.store.choices.values())) {
      if (!choice.enabled) continue;
      const booking = this.store.bookings.get(choice.bookingId);
      if (!booking) continue;
      if (!params.bookingStatuses.includes(booking.status)) continue;
      if (booking.startTime.getTime() > params.startTimeLte.getTime()) continue;
      if (params.endTimeGt !== undefined && booking.endTime.getTime() <= params.endTimeGt.getTime()) continue;
      if (params.pendingDispatch !== undefined && choice.pendingDispatch !== params.pendingDispatch) continue;
      matches.push(booking);
    }
    matches.sort(
      (a, b) => compareNumbers(a.startTime.getTime(), b.startTime.getTime()) || compareNumbers(a.id, b.id)
    );
    return matches.slice(0, params.limit).map((booking) => this.toContext(booking));
  }

  async findByRecurringEventIdFromStartTime(params: {
    recurringEventId: string;
    startTimeGte: Date;
  }): Promise<NotetakerSeriesBookingRecord[]> {
    return this.bookingsByRecurringEventId(params.recurringEventId)
      .filter((booking) => booking.startTime.getTime() >= params.startTimeGte.getTime())
      .sort(
        (a, b) => compareNumbers(a.startTime.getTime(), b.startTime.getTime()) || compareNumbers(a.id, b.id)
      )
      .map((booking) => {
        const choice = this.store.choices.get(booking.id);
        return {
          bookingId: booking.id,
          bookingUid: booking.uid,
          startTime: booking.startTime,
          endTime: booking.endTime,
          status: booking.status,
          choice: choice ? copyChoice(choice) : null,
        };
      });
  }

  async appendNotifiedAttendeeEmails(bookingId: number, emails: string[], at: Date): Promise<void> {
    const choice = this.store.choices.get(bookingId);
    if (!choice) return;
    choice.notifiedAttendeeEmails.push(...emails);
    choice.attendeesNotifiedAt = at;
  }

  async findNotifiedAttendeeEmailsByRecurringEventId(recurringEventId: string): Promise<string[]> {
    const seen = new Set<string>();
    for (const booking of this.bookingsByRecurringEventId(recurringEventId)) {
      const choice = this.store.choices.get(booking.id);
      if (!choice) continue;
      for (const email of choice.notifiedAttendeeEmails) seen.add(email);
    }
    return Array.from(seen);
  }

  async findAttendeesByBookingId(bookingId: number): Promise<NotetakerAttendeeRecord[]> {
    const seed = this.store.bookings.get(bookingId);
    if (!seed) return [];
    const given = this.store.attendees.get(bookingId);
    if (given) return given.map(copyAttendee);
    return seed.attendeeEmails.map((email) => ({ email, name: email, locale: null, timeZone: "UTC" }));
  }

  async findReferencesByBookingIdAndType(params: {
    bookingId: number;
    type: string;
  }): Promise<NotetakerBookingReferenceRecord[]> {
    const given = this.store.references.get(params.bookingId) ?? [];
    return given.filter((reference) => reference.type === params.type).map(copyReference);
  }

  async findSharingGrant(bookingId: number): Promise<NotetakerSharingGrantRecord | null> {
    const grant = this.store.sharingGrants.get(bookingId);
    return grant ? copyGrant(grant) : null;
  }

  async createSharingGrant(data: {
    bookingId: number;
    grantedByUserId: number | null;
  }): Promise<NotetakerSharingGrantRecord> {
    if (!this.store.bookings.has(data.bookingId)) {
      throw new Error(`InMemoryNotetakerStore: booking ${data.bookingId} does not exist`);
    }
    if (this.store.sharingGrants.has(data.bookingId)) {
      throw new Error(`InMemoryNotetakerStore: sharing grant for booking ${data.bookingId} already exists`);
    }
    const grant: NotetakerSharingGrantRecord = {
      bookingId: data.bookingId,
      grantedByUserId: data.grantedByUserId,
      grantedAt: new Date(),
    };
    this.store.sharingGrants.set(data.bookingId, grant);
    return copyGrant(grant);
  }

  async deleteSharingGrant(bookingId: number): Promise<boolean> {
    return this.store.sharingGrants.delete(bookingId);
  }

  async findVerifiedEmailsByUserId(userId: number): Promise<string[]> {
    return [...(this.store.verifiedEmails.get(userId) ?? [])];
  }

  async findWebPushSubscriptionsByUserIds(userIds: number[]): Promise<NotetakerWebPushSubscriptionRecord[]> {
    const result: NotetakerWebPushSubscriptionRecord[] = [];
    Array.from(new Set(userIds)).forEach((userId) => {
      const subscriptions = this.store.webPushSubscriptions.get(userId);
      if (!subscriptions || subscriptions.length === 0) return;
      // The last entry stands for the highest id, which is the row the Prisma repository keeps.
      result.push({ userId, subscription: subscriptions[subscriptions.length - 1] });
    });
    return result;
  }

  async setAppliedToSeries(bookingId: number, appliedToSeries: boolean): Promise<void> {
    const choice = this.store.choices.get(bookingId);
    if (!choice) return;
    choice.appliedToSeries = appliedToSeries;
  }

  async createSharingGrantIfMissing(data: {
    bookingId: number;
    grantedByUserId: number | null;
  }): Promise<boolean> {
    if (!this.store.bookings.has(data.bookingId)) {
      throw new Error(`InMemoryNotetakerStore: booking ${data.bookingId} does not exist`);
    }
    // No await between the check and the write, so concurrent calls give exactly one true.
    if (this.store.sharingGrants.has(data.bookingId)) return false;
    this.store.sharingGrants.set(data.bookingId, {
      bookingId: data.bookingId,
      grantedByUserId: data.grantedByUserId,
      grantedAt: new Date(),
    });
    return true;
  }
}

export class InMemoryEventTypeNotetakerSettingsRepository implements IEventTypeNotetakerSettingsRepository {
  constructor(private readonly store: InMemoryNotetakerStore) {}

  async findByEventTypeId(eventTypeId: number): Promise<EventTypeNotetakerSettingsRecord | null> {
    const settings = this.store.eventTypeSettings.get(eventTypeId);
    return settings ? copySettings(settings) : null;
  }

  async upsert(data: {
    eventTypeId: number;
    enabledByDefault: boolean;
  }): Promise<EventTypeNotetakerSettingsRecord> {
    if (!this.store.eventTypes.has(data.eventTypeId)) {
      throw new Error(`InMemoryNotetakerStore: event type ${data.eventTypeId} does not exist`);
    }
    const settings: EventTypeNotetakerSettingsRecord = {
      eventTypeId: data.eventTypeId,
      enabledByDefault: data.enabledByDefault,
      updatedAt: new Date(),
    };
    this.store.eventTypeSettings.set(data.eventTypeId, settings);
    return copySettings(settings);
  }

  async findByEventTypeIdIncludeEventType(eventTypeId: number): Promise<NotetakerEventTypeContext | null> {
    const seed = this.store.eventTypes.get(eventTypeId);
    if (!seed) return null;
    const settings = this.store.eventTypeSettings.get(eventTypeId);
    return { ...copyEventTypeSeed(seed), settings: settings ? copySettings(settings) : null };
  }
}

export class InMemoryNotetakerSessionRepository implements INotetakerSessionRepository {
  constructor(private readonly store: InMemoryNotetakerStore) {}

  private sessionsOfBookingLatestFirst(bookingId: number): NotetakerSessionRecord[] {
    return Array.from(this.store.sessions.values())
      .filter((session) => session.bookingId === bookingId)
      .sort(compareLatestSessionFirst);
  }

  async create(data: NotetakerSessionCreateInput): Promise<NotetakerSessionRecord> {
    if (!this.store.bookings.has(data.bookingId)) {
      throw new Error(`InMemoryNotetakerStore: booking ${data.bookingId} does not exist`);
    }
    const session: NotetakerSessionRecord = {
      id: this.store.nextId(),
      bookingId: data.bookingId,
      status: data.status ?? "SCHEDULED",
      outcomeReason: data.outcomeReason ?? null,
      platform: data.platform,
      meetingUrl: data.meetingUrl,
      botProvider: data.botProvider,
      externalRef: null,
      displayName: data.displayName,
      scheduledStartAt: data.scheduledStartAt,
      dispatchedAt: data.dispatchedAt ?? new Date(),
      joinRequestedAt: null,
      admittedAt: null,
      noticePostedAt: null,
      endedAt: data.endedAt ?? null,
      startedLate: data.startedLate ?? false,
      rejoinAttempted: false,
      interruptedAtMs: null,
      lastHeartbeatAt: null,
      lastEventSequence: 0,
      stopRequestedAt: null,
      stopRequestedByUserId: null,
      resultsDeletedAt: null,
      createdAt: new Date(),
    };
    this.store.sessions.set(session.id, session);
    return copySession(session);
  }

  async findById(id: string): Promise<NotetakerSessionRecord | null> {
    const session = this.store.sessions.get(id);
    return session ? copySession(session) : null;
  }

  async findLatestByBookingId(bookingId: number): Promise<NotetakerSessionRecord | null> {
    const latest = this.sessionsOfBookingLatestFirst(bookingId)[0];
    return latest ? copySession(latest) : null;
  }

  async findLatestWithTranscriptByBookingId(
    bookingId: number
  ): Promise<{ session: NotetakerSessionRecord; transcript: NotetakerTranscriptRecord } | null> {
    const transcriptsBySessionId = new Map<string, NotetakerTranscriptRecord>();
    for (const transcript of Array.from(this.store.transcripts.values())) {
      transcriptsBySessionId.set(transcript.sessionId, transcript);
    }
    for (const session of this.sessionsOfBookingLatestFirst(bookingId)) {
      const transcript = transcriptsBySessionId.get(session.id);
      if (transcript) return { session: copySession(session), transcript: copyTranscript(transcript) };
    }
    return null;
  }

  async findByBookingIdAndStatusIn(
    bookingId: number,
    statuses: NotetakerSessionStatusDto[]
  ): Promise<NotetakerSessionRecord | null> {
    const match = this.sessionsOfBookingLatestFirst(bookingId).find((session) =>
      statuses.includes(session.status)
    );
    return match ? copySession(match) : null;
  }

  async updateIfStatusIn(
    id: string,
    fromStatuses: NotetakerSessionStatusDto[],
    data: NotetakerSessionUpdateInput
  ): Promise<boolean> {
    const session = this.store.sessions.get(id);
    if (!session || !fromStatuses.includes(session.status)) return false;
    applyDefined(session, data);
    return true;
  }

  async update(id: string, data: NotetakerSessionUpdateInput): Promise<void> {
    const session = this.store.sessions.get(id);
    if (!session) return;
    applyDefined(session, data);
  }

  async deleteById(id: string): Promise<boolean> {
    if (!this.store.sessions.delete(id)) return false;
    for (const transcript of Array.from(this.store.transcripts.values())) {
      if (transcript.sessionId === id) this.store.removeTranscript(transcript.id);
    }
    return true;
  }

  async findByStatusInIncludeBooking(params: {
    statuses: NotetakerSessionStatusDto[];
    limit: number;
  }): Promise<(NotetakerSessionRecord & { bookingStatus: NotetakerBookingStatus })[]> {
    const rows: { session: NotetakerSessionRecord; booking: InMemoryBookingSeed }[] = [];
    for (const session of Array.from(this.store.sessions.values())) {
      if (!params.statuses.includes(session.status)) continue;
      const booking = this.store.bookings.get(session.bookingId);
      if (booking) rows.push({ session, booking });
    }
    rows.sort(
      (a, b) =>
        compareNumbers(a.booking.startTime.getTime(), b.booking.startTime.getTime()) ||
        compareStrings(a.session.id, b.session.id)
    );
    return rows
      .slice(0, params.limit)
      .map(({ session, booking }) => ({ ...copySession(session), bookingStatus: booking.status }));
  }

  async setResultsDeletedAtByIds(ids: string[], at: Date): Promise<number> {
    let updated = 0;
    for (const id of Array.from(new Set(ids))) {
      const session = this.store.sessions.get(id);
      if (!session) continue;
      session.resultsDeletedAt = at;
      updated += 1;
    }
    return updated;
  }
}

export class InMemoryNotetakerTranscriptRepository implements INotetakerTranscriptRepository {
  constructor(private readonly store: InMemoryNotetakerStore) {}

  private sortedPassages(transcriptId: string): NotetakerPassageRecord[] {
    return Array.from(this.store.passages.get(transcriptId)?.values() ?? []).sort((a, b) =>
      compareNumbers(a.index, b.index)
    );
  }

  async findBySessionId(sessionId: string): Promise<NotetakerTranscriptRecord | null> {
    for (const transcript of Array.from(this.store.transcripts.values())) {
      if (transcript.sessionId === sessionId) return copyTranscript(transcript);
    }
    return null;
  }

  async findById(id: string): Promise<NotetakerTranscriptRecord | null> {
    const transcript = this.store.transcripts.get(id);
    return transcript ? copyTranscript(transcript) : null;
  }

  async findIdsByBookingId(bookingId: number): Promise<{ id: string; sessionId: string }[]> {
    return Array.from(this.store.transcripts.values())
      .filter((transcript) => transcript.bookingId === bookingId)
      .sort(
        (a, b) => compareNumbers(a.createdAt.getTime(), b.createdAt.getTime()) || compareStrings(a.id, b.id)
      )
      .map((transcript) => ({ id: transcript.id, sessionId: transcript.sessionId }));
  }

  async createIfMissing(data: { sessionId: string; bookingId: number }): Promise<NotetakerTranscriptRecord> {
    for (const transcript of Array.from(this.store.transcripts.values())) {
      if (transcript.sessionId === data.sessionId) return copyTranscript(transcript);
    }
    if (!this.store.sessions.has(data.sessionId)) {
      throw new Error(`InMemoryNotetakerStore: session ${data.sessionId} does not exist`);
    }
    if (!this.store.bookings.has(data.bookingId)) {
      throw new Error(`InMemoryNotetakerStore: booking ${data.bookingId} does not exist`);
    }
    const transcript: NotetakerTranscriptRecord = {
      id: this.store.nextId(),
      sessionId: data.sessionId,
      bookingId: data.bookingId,
      language: null,
      completeness: "PARTIAL",
      durationMs: 0,
      passageCount: 0,
      createdAt: new Date(),
    };
    this.store.transcripts.set(transcript.id, transcript);
    return copyTranscript(transcript);
  }

  async insertPassages(transcriptId: string, passages: NotetakerPassageRecord[]): Promise<number> {
    if (passages.length === 0) return 0;
    if (!this.store.transcripts.has(transcriptId)) {
      throw new Error(`InMemoryNotetakerStore: transcript ${transcriptId} does not exist`);
    }
    let stored = this.store.passages.get(transcriptId);
    if (!stored) {
      stored = new Map<number, NotetakerPassageRecord>();
      this.store.passages.set(transcriptId, stored);
    }
    let inserted = 0;
    for (const passage of passages) {
      if (stored.has(passage.index)) continue;
      stored.set(passage.index, copyPassage(passage));
      inserted += 1;
    }
    return inserted;
  }

  async countPassages(transcriptId: string): Promise<number> {
    return this.store.passages.get(transcriptId)?.size ?? 0;
  }

  async findPassagesPage(params: {
    transcriptId: string;
    cursor: number | null;
    limit: number;
  }): Promise<NotetakerPassageRecord[]> {
    const { cursor } = params;
    return this.sortedPassages(params.transcriptId)
      .filter((passage) => cursor === null || passage.index > cursor)
      .slice(0, params.limit)
      .map(copyPassage);
  }

  async findAllPassages(transcriptId: string): Promise<NotetakerPassageRecord[]> {
    return this.sortedPassages(transcriptId).map(copyPassage);
  }

  async findLastPassageEndMs(transcriptId: string): Promise<number | null> {
    const passages = this.sortedPassages(transcriptId);
    if (passages.length === 0) return null;
    let max = passages[0].endMs;
    for (const passage of passages) {
      if (passage.endMs > max) max = passage.endMs;
    }
    return max;
  }

  async update(
    id: string,
    data: Partial<
      Pick<NotetakerTranscriptRecord, "language" | "completeness" | "durationMs" | "passageCount">
    >
  ): Promise<NotetakerTranscriptRecord> {
    const transcript = this.store.transcripts.get(id);
    if (!transcript) {
      throw new Error(`InMemoryNotetakerStore: transcript ${id} does not exist`);
    }
    applyDefined(transcript, data);
    return copyTranscript(transcript);
  }

  async deleteById(id: string): Promise<void> {
    this.store.removeTranscript(id);
  }

  async deleteByBookingId(bookingId: number): Promise<number> {
    const ids = Array.from(this.store.transcripts.values())
      .filter((transcript) => transcript.bookingId === bookingId)
      .map((transcript) => transcript.id);
    for (const id of ids) {
      this.store.removeTranscript(id);
    }
    return ids.length;
  }
}

export class InMemoryNotetakerSummaryRepository implements INotetakerSummaryRepository {
  constructor(private readonly store: InMemoryNotetakerStore) {}

  private require(transcriptId: string): NotetakerSummaryRecord {
    const summary = this.store.summaries.get(transcriptId);
    if (!summary) {
      throw new Error(`InMemoryNotetakerStore: summary for transcript ${transcriptId} does not exist`);
    }
    return summary;
  }

  async findByTranscriptId(transcriptId: string): Promise<NotetakerSummaryRecord | null> {
    const summary = this.store.summaries.get(transcriptId);
    return summary ? copySummary(summary) : null;
  }

  async upsertPending(transcriptId: string): Promise<NotetakerSummaryRecord> {
    if (!this.store.transcripts.has(transcriptId)) {
      throw new Error(`InMemoryNotetakerStore: transcript ${transcriptId} does not exist`);
    }
    const existing = this.store.summaries.get(transcriptId);
    if (existing) {
      existing.status = "PENDING";
      existing.failureCode = null;
      return copySummary(existing);
    }
    const summary: NotetakerSummaryRecord = {
      id: this.store.nextId(),
      transcriptId,
      status: "PENDING",
      language: null,
      overview: null,
      keyPoints: [],
      decisions: [],
      actionItems: [],
      model: null,
      attempts: 0,
      failureCode: null,
      generatedAt: null,
    };
    this.store.summaries.set(transcriptId, summary);
    return copySummary(summary);
  }

  async incrementAttempts(transcriptId: string): Promise<number> {
    const summary = this.require(transcriptId);
    summary.attempts += 1;
    return summary.attempts;
  }

  async saveResult(
    transcriptId: string,
    data: Pick<
      NotetakerSummaryRecord,
      "status" | "language" | "overview" | "keyPoints" | "decisions" | "actionItems" | "model" | "generatedAt"
    >
  ): Promise<NotetakerSummaryRecord> {
    const summary = this.require(transcriptId);
    summary.status = data.status;
    summary.language = data.language;
    summary.overview = data.overview;
    summary.keyPoints = [...data.keyPoints];
    summary.decisions = [...data.decisions];
    summary.actionItems = data.actionItems.map((item) => ({ ...item }));
    summary.model = data.model;
    summary.generatedAt = data.generatedAt;
    return copySummary(summary);
  }

  async setStatus(
    transcriptId: string,
    status: NotetakerSummaryStatusDto,
    failureCode: string | null
  ): Promise<void> {
    const summary = this.require(transcriptId);
    summary.status = status;
    summary.failureCode = failureCode;
  }
}

export class InMemoryNotetakerActivityRepository implements INotetakerActivityRepository {
  constructor(private readonly store: InMemoryNotetakerStore) {}

  async create(data: Omit<NotetakerActivityRecord, "id" | "createdAt">): Promise<NotetakerActivityRecord> {
    if (!this.store.bookings.has(data.bookingId)) {
      throw new Error(`InMemoryNotetakerStore: booking ${data.bookingId} does not exist`);
    }
    const activity: NotetakerActivityRecord = {
      ...data,
      // Prisma JSON-normalises detail on write; mirror it so tests cannot assert on shapes production never returns.
      detail: cloneDetail(data.detail),
      id: this.store.nextId(),
      createdAt: new Date(),
    };
    this.store.activities.push(activity);
    return copyActivity(activity);
  }

  async findByBookingId(params: { bookingId: number; limit: number }): Promise<NotetakerActivityRecord[]> {
    return this.store.activities
      .filter((activity) => activity.bookingId === params.bookingId)
      .sort(
        (a, b) => compareNumbers(b.createdAt.getTime(), a.createdAt.getTime()) || compareStrings(b.id, a.id)
      )
      .slice(0, params.limit)
      .map(copyActivity);
  }

  async findDistinctActorUserIdsByBookingIdAndAction(params: {
    bookingId: number;
    action: NotetakerActivityActionDto;
  }): Promise<number[]> {
    const seen = new Set<number>();
    for (const activity of this.store.activities) {
      if (activity.bookingId !== params.bookingId || activity.action !== params.action) continue;
      if (activity.actorUserId !== null) seen.add(activity.actorUserId);
    }
    return Array.from(seen);
  }
}

export function createInMemoryNotetakerRepositories(): {
  store: InMemoryNotetakerStore;
  bookingNotetakerRepository: InMemoryBookingNotetakerRepository;
  eventTypeNotetakerSettingsRepository: InMemoryEventTypeNotetakerSettingsRepository;
  sessionRepository: InMemoryNotetakerSessionRepository;
  transcriptRepository: InMemoryNotetakerTranscriptRepository;
  summaryRepository: InMemoryNotetakerSummaryRepository;
  activityRepository: InMemoryNotetakerActivityRepository;
} {
  const store = new InMemoryNotetakerStore();
  return {
    store,
    bookingNotetakerRepository: new InMemoryBookingNotetakerRepository(store),
    eventTypeNotetakerSettingsRepository: new InMemoryEventTypeNotetakerSettingsRepository(store),
    sessionRepository: new InMemoryNotetakerSessionRepository(store),
    transcriptRepository: new InMemoryNotetakerTranscriptRepository(store),
    summaryRepository: new InMemoryNotetakerSummaryRepository(store),
    activityRepository: new InMemoryNotetakerActivityRepository(store),
  };
}

export type { InMemoryBookingSeed, InMemoryEventTypeSeed };
