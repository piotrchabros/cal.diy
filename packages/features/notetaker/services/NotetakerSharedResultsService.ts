import type {
  NotetakerSharedResultDto,
  NotetakerSharedResultRouteDto,
  NotetakerSharedResultsDto,
} from "@calcom/lib/dto/NotetakerSharedResultDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { INotetakerMembershipLookup } from "../lib/membershipLookup";
import type { NotetakerSharingTeam } from "../lib/sharingScope";
import { deriveNotetakerSharingTeam } from "../lib/sharingScope";
import type { INotetakerUserLookup } from "../lib/userLookup";
import type {
  IBookingNotetakerRepository,
  NotetakerAdHocBookingWithResultsSessionRecord,
  NotetakerBookingWithResultsSessionRecord,
} from "../repositories/interfaces/IBookingNotetakerRepository";
import type { IEventTypeNotetakerSettingsRepository } from "../repositories/interfaces/IEventTypeNotetakerSettingsRepository";

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

type SharingOwner = Pick<NotetakerSharingTeam, "sharingOwnerUserId"> & { teamId: number };

type ListedRow =
  | { source: "EVENT_TYPE"; row: NotetakerBookingWithResultsSessionRecord }
  | { source: "AD_HOC"; row: NotetakerAdHocBookingWithResultsSessionRecord };

export interface INotetakerSharedResultsServiceDeps {
  bookingNotetakerRepository: Pick<
    IBookingNotetakerRepository,
    | "findByEventTypeIdsIncludeResultsSession"
    | "findAdHocBySharingTeamIdsIncludeResultsSession"
    | "findVerifiedEmailsByUserId"
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

function formatCursor(row: { startTime: Date; bookingId: number }): string {
  return `${row.startTime.toISOString()}${CURSOR_SEPARATOR}${row.bookingId}`;
}

// Both sources come from the booking table, so (startTime desc, id desc) orders them as one list.
function compareNewestFirst(a: ListedRow, b: ListedRow): number {
  const byStartTime = b.row.startTime.getTime() - a.row.startTime.getTime();
  if (byStartTime !== 0) return byStartTime;
  return b.row.bookingId - a.row.bookingId;
}

/**
 * The creator owns an ad-hoc meeting, resolved as the booking context does for NotetakerAccessService.
 * Null when there is no owner, which leaves the booking unshared.
 */
function adHocSharingOwner(row: NotetakerAdHocBookingWithResultsSessionRecord): SharingOwner | null {
  const sharingTeam = deriveNotetakerSharingTeam({
    eventTypeTeam: null,
    eventTypeUserId: row.organizerUserId,
    chosenTeam: { id: row.sharingTeamId, name: row.sharingTeamName ?? "" },
  });
  if (sharingTeam.teamId === null || sharingTeam.sharingOwnerUserId === null) return null;
  return { teamId: sharingTeam.teamId, sharingOwnerUserId: sharingTeam.sharingOwnerUserId };
}

const EMPTY_PAGE: NotetakerSharedResultsDto = { items: [], nextCursor: null };

/**
 * Lists the results a colleague can read through an event type's sharing mode or through the team
 * chosen on an ad-hoc meeting. It applies the same rules as the shared-viewer check of
 * NotetakerAccessService, so every row it returns opens.
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
    const { bookingNotetakerRepository } = this.deps;
    // Each source is read to limit + 1 so the merged list still knows whether an older row remains.
    const [eventTypeRows, adHocRows] = await Promise.all([
      sharedEventTypes.size === 0
        ? []
        : bookingNotetakerRepository.findByEventTypeIdsIncludeResultsSession({
            eventTypeIds: Array.from(sharedEventTypes.keys()),
            cursor,
            limit: limit + 1,
          }),
      bookingNotetakerRepository.findAdHocBySharingTeamIdsIncludeResultsSession({
        teamIds,
        cursor,
        limit: limit + 1,
      }),
    ]);
    const rows: ListedRow[] = [
      ...eventTypeRows.map((row) => ({ source: "EVENT_TYPE" as const, row })),
      ...adHocRows.map((row) => ({ source: "AD_HOC" as const, row })),
    ].sort(compareNewestFirst);
    const page = rows.slice(0, limit);
    // Built before filtering: a page can lose every row to the filter while older rows remain.
    const nextCursor = rows.length > limit ? formatCursor(page[page.length - 1].row) : null;

    const adHocOwners: SharingOwner[] = [];
    for (const listed of page) {
      const owner = listed.source === "AD_HOC" ? adHocSharingOwner(listed.row) : null;
      if (owner) adHocOwners.push(owner);
    }
    const [ownEmails, ownerIsMember] = await Promise.all([
      this.findOwnEmails(userId),
      this.buildOwnerMembershipCheck(adHocOwners),
    ]);

    const items: NotetakerSharedResultDto[] = [];
    for (const listed of page) {
      const { row } = listed;
      const resultsSession = row.resultsSession;
      if (!resultsSession) continue;
      if (!resultsSession.colleagueSharingDisclosed || resultsSession.resultsDeletedAt !== null) continue;
      // Hosts and attendees reach their own bookings from the bookings list.
      if (row.organizerUserId === userId) continue;
      if (row.attendeeEmails.some((email) => ownEmails.has(normalizeEmail(email)))) continue;

      let shared: { route: NotetakerSharedResultRouteDto; eventTypeTitle: string | null; teamName: string };
      if (listed.source === "EVENT_TYPE") {
        const sharedEventType = sharedEventTypes.get(listed.row.eventTypeId);
        if (!sharedEventType) continue;
        shared = sharedEventType;
      } else {
        // A deleted team leaves the booking in HOSTS_ONLY, and an owner who left the team takes the sharing along.
        const owner = adHocSharingOwner(listed.row);
        if (!owner || listed.row.sharingTeamName === null || !ownerIsMember(owner)) continue;
        shared = { route: "TEAM", eventTypeTitle: null, teamName: listed.row.sharingTeamName };
      }

      items.push({
        bookingUid: row.bookingUid,
        title: row.title,
        startTime: row.startTime.toISOString(),
        eventTypeTitle: shared.eventTypeTitle,
        teamName: shared.teamName,
        hostName: row.organizerName,
        route: shared.route,
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
   * A personal event type or an ad-hoc meeting shares only while its owner is an accepted member of
   * the chosen team. Same rule as resolveNotetakerSharingScope, asked once per team instead of once per row.
   */
  private async buildOwnerMembershipCheck(
    eventTypes: SharingOwner[]
  ): Promise<(eventType: SharingOwner) => boolean> {
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
