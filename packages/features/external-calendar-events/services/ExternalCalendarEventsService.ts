import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { IFeaturesRepository } from "@calcom/features/flags/features.repository.interface";
import type {
  INotetakerCalendarEventsGatewayResolver,
  NotetakerAutoJoinCalendarRecord,
} from "@calcom/features/notetaker/calendar/INotetakerCalendarEventsGateway";
import type { NotetakerCalendarEvent } from "@calcom/features/notetaker/lib/calendarMeeting";
import type {
  ExternalCalendarEventDto,
  ExternalCalendarEventsDto,
} from "@calcom/lib/dto/ExternalCalendarEventDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import {
  type CalDiyMatchSets,
  type CalendarEventEntry,
  EXTERNAL_CALENDAR_EVENTS_FEATURE_SLUG,
  type ExternalCalendarRef,
  findSupportedMeetingLink,
  isRepresentedInCalDiy,
  MAX_RANGE_MS,
  mapWithConcurrency,
  type SupportedMeetingLink,
  selectVisibleEntries,
  toExternalCalendarEventDto,
  withTimeout,
} from "../lib/externalCalendarEvents";
import type { IExternalCalendarEventsCache } from "../lib/InMemoryExternalCalendarEventsCache";
import type { IExternalCalendarEventsRepository } from "../repositories/interfaces/IExternalCalendarEventsRepository";

const SECOND_MS = 1000;
const PROVIDER_TIMEOUT_MS = 8 * SECOND_MS;
const FETCH_CONCURRENCY = 4;
const CACHE_TTL_MS = 60 * SECOND_MS;

export interface IExternalCalendarEventsServiceDeps {
  repository: IExternalCalendarEventsRepository;
  eventsGatewayResolver: INotetakerCalendarEventsGatewayResolver;
  featuresRepository: Pick<IFeaturesRepository, "checkIfUserHasFeature">;
  cache: IExternalCalendarEventsCache;
  logger: ISimpleLogger;
}

export type ExternalCalendarEventsListParams = {
  userId: number;
  userEmail: string;
  from: Date;
  to: Date;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function compareEvents(a: ExternalCalendarEventDto, b: ExternalCalendarEventDto): number {
  const byStart = a.start.getTime() - b.start.getTime();
  if (byStart !== 0) return byStart;
  return (a.title ?? "").localeCompare(b.title ?? "");
}

export class ExternalCalendarEventsService {
  constructor(private readonly deps: IExternalCalendarEventsServiceDeps) {}

  async list(params: ExternalCalendarEventsListParams): Promise<ExternalCalendarEventsDto> {
    const { repository, eventsGatewayResolver, featuresRepository, logger } = this.deps;
    const { userId, from, to } = params;

    if (!(await featuresRepository.checkIfUserHasFeature(userId, EXTERNAL_CALENDAR_EVENTS_FEATURE_SLUG))) {
      return { available: false, events: [], failedCalendarCount: 0 };
    }
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw ErrorWithCode.Factory.BadRequest("INVALID_RANGE");
    }

    const calendars = await repository.findUserLevelSelectedCalendarsByIntegrations({
      userId,
      integrations: eventsGatewayResolver.supportedIntegrations(),
    });
    if (calendars.length === 0) return { available: true, events: [], failedCalendarCount: 0 };

    const results = await mapWithConcurrency(calendars, FETCH_CONCURRENCY, (calendar) =>
      this.fetchEvents(calendar, userId, from, to)
    );
    const entries: CalendarEventEntry[] = [];
    let failedCalendarCount = 0;
    results.forEach((result, index) => {
      const calendar = calendars[index];
      if (result.status === "rejected") {
        failedCalendarCount += 1;
        logger.warn("External calendar events fetch failed", {
          selectedCalendarId: calendar.selectedCalendarId,
          integration: calendar.integration,
          message: errorMessage(result.reason),
        });
        return;
      }
      for (const event of result.value) entries.push({ calendar, event });
    });

    const visible = selectVisibleEntries(entries);
    if (visible.length === 0) return { available: true, events: [], failedCalendarCount };

    const links = visible.map((entry) => findSupportedMeetingLink(entry.event.candidateLinks));
    const sets = await this.loadMatchSets(params, visible, links);
    const events = visible.flatMap((entry, index) => {
      const link = links[index];
      if (isRepresentedInCalDiy(entry, link?.meetingUrl ?? null, sets)) return [];
      return [toExternalCalendarEventDto(entry, link)];
    });
    events.sort(compareEvents);
    return { available: true, events, failedCalendarCount };
  }

  private async fetchEvents(
    calendar: ExternalCalendarRef,
    userId: number,
    from: Date,
    to: Date
  ): Promise<NotetakerCalendarEvent[]> {
    const { eventsGatewayResolver, cache } = this.deps;
    const gateway = eventsGatewayResolver.resolve(calendar.integration);
    if (!gateway) return [];

    const cacheKey = `${calendar.selectedCalendarId}|${from.toISOString()}|${to.toISOString()}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const record: NotetakerAutoJoinCalendarRecord = {
      selectedCalendarId: calendar.selectedCalendarId,
      userId,
      integration: calendar.integration,
      externalId: calendar.externalId,
      credentialId: calendar.credentialId,
      delegationCredentialId: calendar.delegationCredentialId,
      sharingTeamId: null,
      lastPolledAt: null,
    };
    const events = await withTimeout(
      gateway.listEvents({ calendar: record, timeMin: from, timeMax: to }),
      PROVIDER_TIMEOUT_MS,
      `External calendar ${calendar.selectedCalendarId}`
    );
    cache.set(cacheKey, events, CACHE_TTL_MS);
    return events;
  }

  // Cal.diy matches are read live on every call: a booking made or cancelled a second ago must change the result.
  private async loadMatchSets(
    params: ExternalCalendarEventsListParams,
    entries: CalendarEventEntry[],
    links: (SupportedMeetingLink | null)[]
  ): Promise<CalDiyMatchSets> {
    const { repository } = this.deps;
    const { userId, userEmail, from, to } = params;
    const iCalUIDs = unique(entries.flatMap(({ event }) => (event.iCalUID ? [event.iCalUID] : [])));
    const referenceUids = unique(
      entries.flatMap(({ event }) =>
        event.recurringEventId ? [event.externalId, event.recurringEventId] : [event.externalId]
      )
    );
    const selectedCalendarIds = unique(entries.map(({ calendar }) => calendar.selectedCalendarId));
    const locations = unique(links.flatMap((link) => (link ? [link.meetingUrl] : [])));

    const [bookingKeys, participantKeys, bookedLocations] = await Promise.all([
      repository.findLiveBookingMatchKeysForUser({ userId, userEmail, iCalUIDs, referenceUids }),
      repository.findActiveCalendarMeetingEventKeysByUserId({ userId, selectedCalendarIds }),
      repository.findLiveBookingLocationsByUserIdInRange({ userId, locations, from, to }),
    ]);
    return {
      iCalUIDs: new Set(bookingKeys.iCalUIDs),
      referenceUids: new Set(bookingKeys.referenceUids),
      participantEventKeys: new Set(
        participantKeys.map((key) => `${key.selectedCalendarId}:${key.externalEventId}`)
      ),
      bookedLocations,
    };
  }
}
