import type {
  NotetakerSharedResultDto,
  NotetakerSharedResultRouteDto,
  NotetakerSharedResultsDto,
} from "@calcom/lib/dto/NotetakerSharedResultDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { INotetakerMembershipLookup } from "../lib/membershipLookup";
import type { INotetakerUserLookup } from "../lib/userLookup";
import type {
  IBookingNotetakerRepository,
  NotetakerBookingWithResultsSessionRecord,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type {
  IEventTypeNotetakerSettingsRepository,
  NotetakerSharedEventTypeRecord,
} from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const CURSOR_SEPARATOR = "|";
const BOOKING_ID_PATTERN = /^\d+$/;

type SharedEventType = {
  route: NotetakerSharedResultRouteDto;
  eventTypeTitle: string;
  teamName: string;
};

type BookingCursor = { startTime: Date; id: number };

export interface INotetakerSharedResultsServiceDeps {
  bookingNotetakerRepository: Pick<
    IBookingNotetakerRepository,
    "findByEventTypeIdsIncludeResultsSession" | "findVerifiedEmailsByUserId"
  >;
  eventTypeNotetakerSettingsRepository: Pick<
    IEventTypeNotetakerSettingsRepository,
    "findByTeamIdsAndSharingModeIncludeEventType" | "findBySharingMemberUserIdIncludeEventType"
  >;
  membershipLookup: Pick<INotetakerMembershipLookup, "listAcceptedTeamIds" | "findAcceptedUserIds">;
  userRepository: INotetakerUserLookup;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseCursor(cursor: string): BookingCursor {
  const parts = cursor.split(CURSOR_SEPARATOR);
  if (parts.length !== 2 || !BOOKING_ID_PATTERN.test(parts[1])) {
    throw ErrorWithCode.Factory.BadRequest("INVALID_CURSOR");
  }
  const startTime = new Date(parts[0]);
  const id = Number(parts[1]);
  if (Number.isNaN(startTime.getTime()) || !Number.isSafeInteger(id)) {
    throw ErrorWithCode.Factory.BadRequest("INVALID_CURSOR");
  }
  return { startTime, id };
}

function formatCursor(row: NotetakerBookingWithResultsSessionRecord): string {
  return `${row.startTime.toISOString()}${CURSOR_SEPARATOR}${row.bookingId}`;
}

const EMPTY_PAGE: NotetakerSharedResultsDto = { items: [], nextCursor: null };

/**
 * Lists the results a colleague can read through an event type's sharing mode. It applies the
 * same rules as the shared-viewer check of NotetakerAccessService, so every row it returns opens.
 */
export class NotetakerSharedResultsService {
  constructor(private readonly deps: INotetakerSharedResultsServiceDeps) {}

  async list(params: {
    userId: number;
    cursor?: string | null;
    limit?: number;
  }): Promise<NotetakerSharedResultsDto> {
    const { userId } = params;
    const cursor = params.cursor === undefined || params.cursor === null ? null : parseCursor(params.cursor);
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT);

    const teamIds = await this.deps.membershipLookup.listAcceptedTeamIds({ userId });
    if (teamIds.length === 0) return { ...EMPTY_PAGE };

    const sharedEventTypes = await this.findSharedEventTypes(userId, teamIds);
    if (sharedEventTypes.size === 0) return { ...EMPTY_PAGE };

    const rows = await this.deps.bookingNotetakerRepository.findByEventTypeIdsIncludeResultsSession({
      eventTypeIds: Array.from(sharedEventTypes.keys()),
      cursor,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    // Built before filtering: a page can lose every row to the filter while older rows remain.
    const nextCursor = rows.length > limit ? formatCursor(page[page.length - 1]) : null;

    const ownEmails = await this.findOwnEmails(userId);
    const items: NotetakerSharedResultDto[] = [];
    for (const row of page) {
      const sharedEventType = sharedEventTypes.get(row.eventTypeId);
      const resultsSession = row.resultsSession;
      if (!sharedEventType || !resultsSession) continue;
      if (!resultsSession.colleagueSharingDisclosed || resultsSession.resultsDeletedAt !== null) continue;
      // Hosts and attendees reach their own bookings from the bookings list.
      if (row.organizerUserId === userId) continue;
      if (row.attendeeEmails.some((email) => ownEmails.has(normalizeEmail(email)))) continue;

      items.push({
        bookingUid: row.bookingUid,
        title: row.title,
        startTime: row.startTime.toISOString(),
        eventTypeTitle: sharedEventType.eventTypeTitle,
        teamName: sharedEventType.teamName,
        hostName: row.organizerName,
        route: sharedEventType.route,
        summaryStatus: resultsSession.summaryStatus,
      });
    }

    return { items, nextCursor };
  }

  private async findSharedEventTypes(
    userId: number,
    teamIds: number[]
  ): Promise<Map<number, SharedEventType>> {
    const { eventTypeNotetakerSettingsRepository } = this.deps;
    const [teamShared, memberOf] = await Promise.all([
      eventTypeNotetakerSettingsRepository.findByTeamIdsAndSharingModeIncludeEventType({
        teamIds,
        sharingMode: "TEAM",
      }),
      eventTypeNotetakerSettingsRepository.findBySharingMemberUserIdIncludeEventType({ userId }),
    ]);

    const acceptedTeamIds = new Set(teamIds);
    // The list outlives a mode change, so a listed person counts only while the mode says so.
    const selectedFor = memberOf.filter(
      (eventType) =>
        eventType.sharingMode === "SELECTED_PEOPLE" &&
        acceptedTeamIds.has(eventType.organizationId ?? eventType.teamId)
    );
    const ownerIsMember = await this.buildOwnerMembershipCheck([...teamShared, ...selectedFor]);

    const sharedEventTypes = new Map<number, SharedEventType>();
    for (const eventType of teamShared) {
      if (!ownerIsMember(eventType)) continue;
      sharedEventTypes.set(eventType.eventTypeId, {
        route: "TEAM",
        eventTypeTitle: eventType.eventTypeTitle,
        teamName: eventType.teamName,
      });
    }
    for (const eventType of selectedFor) {
      if (!ownerIsMember(eventType)) continue;
      sharedEventTypes.set(eventType.eventTypeId, {
        route: "SELECTED_PEOPLE",
        eventTypeTitle: eventType.eventTypeTitle,
        teamName: eventType.teamName,
      });
    }
    return sharedEventTypes;
  }

  /**
   * A personal event type shares only while its owner is an accepted member of the chosen team.
   * Same rule as resolveNotetakerSharingScope, asked once per team instead of once per event type.
   */
  private async buildOwnerMembershipCheck(
    eventTypes: NotetakerSharedEventTypeRecord[]
  ): Promise<(eventType: NotetakerSharedEventTypeRecord) => boolean> {
    const ownerIdsByTeamId = new Map<number, Set<number>>();
    for (const eventType of eventTypes) {
      if (eventType.sharingOwnerUserId === null) continue;
      const ownerIds = ownerIdsByTeamId.get(eventType.teamId) ?? new Set<number>();
      ownerIds.add(eventType.sharingOwnerUserId);
      ownerIdsByTeamId.set(eventType.teamId, ownerIds);
    }

    const acceptedOwnerIdsByTeamId = new Map<number, Set<number>>();
    await Promise.all(
      Array.from(ownerIdsByTeamId.entries()).map(async ([teamId, ownerIds]) => {
        const accepted = await this.deps.membershipLookup.findAcceptedUserIds({
          teamId,
          userIds: Array.from(ownerIds),
        });
        acceptedOwnerIdsByTeamId.set(teamId, new Set(accepted));
      })
    );

    return (eventType) =>
      eventType.sharingOwnerUserId === null ||
      (acceptedOwnerIdsByTeamId.get(eventType.teamId)?.has(eventType.sharingOwnerUserId) ?? false);
  }

  private async findOwnEmails(userId: number): Promise<Set<string>> {
    const [verifiedEmails, users] = await Promise.all([
      this.deps.bookingNotetakerRepository.findVerifiedEmailsByUserId(userId),
      this.deps.userRepository.findByIds({ ids: [userId] }),
    ]);
    const ownEmails = new Set(verifiedEmails.map(normalizeEmail));
    for (const user of users) {
      ownEmails.add(normalizeEmail(user.email));
    }
    return ownEmails;
  }
}
