import { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { HostRepository } from "@calcom/features/host/repositories/HostRepository";
import { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { TeamRepository } from "@calcom/features/teams/repositories/TeamRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { ErrorWithCode } from "@calcom/lib/errors";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import type { PrismaClient } from "@calcom/prisma/client";
import type {
  AssignmentChild,
  AssignmentHost,
  AvailabilityHost,
  ExportedWeightMember,
  ExportWeightsResponse,
  IEventTypeHostService,
  PaginatedAssignmentChildrenResponse,
  PaginatedAssignmentHostsResponse,
  PaginatedAvailabilityHostsResponse,
  PaginatedTeamMembersResponse,
  TeamMemberSearchResult,
} from "./IEventTypeHostService";

export type EventTypeHostServiceDeps = {
  hostRepository: Pick<
    HostRepository,
    | "findHostsPaginatedIncludeUser"
    | "findHostsPaginatedIncludeUserForAssignment"
    | "findChildrenForAssignmentPaginated"
    | "findAllRoundRobinHosts"
  >;
  membershipRepository: Pick<
    MembershipRepository,
    "hasMembership" | "searchMembers" | "findAcceptedMembersWithUserProfile"
  >;
  eventTypeRepository: Pick<EventTypeRepository, "getTeamIdByEventTypeId">;
  teamRepository: Pick<TeamRepository, "findBasicById">;
  userRepository: Pick<UserRepository, "findOrganizationIdsByIds">;
};

export class EventTypeHostService implements IEventTypeHostService {
  private hostRepository: EventTypeHostServiceDeps["hostRepository"];
  private membershipRepository: EventTypeHostServiceDeps["membershipRepository"];
  private eventTypeRepository: EventTypeHostServiceDeps["eventTypeRepository"];
  private teamRepository: EventTypeHostServiceDeps["teamRepository"];
  private userRepository: EventTypeHostServiceDeps["userRepository"];

  constructor(
    private prismaClient: PrismaClient,
    deps: Partial<EventTypeHostServiceDeps> = {}
  ) {
    this.hostRepository = deps.hostRepository ?? new HostRepository(prismaClient);
    this.membershipRepository = deps.membershipRepository ?? new MembershipRepository(prismaClient);
    this.eventTypeRepository = deps.eventTypeRepository ?? new EventTypeRepository(prismaClient);
    this.teamRepository = deps.teamRepository ?? new TeamRepository(prismaClient);
    this.userRepository = deps.userRepository ?? new UserRepository(prismaClient);
  }

  async getHostsForAvailability({
    eventTypeId,
    cursor,
    limit,
    search,
  }: {
    eventTypeId: number;
    cursor?: number;
    limit: number;
    search?: string;
  }): Promise<PaginatedAvailabilityHostsResponse> {
    const { items, nextCursor, hasMore } = await this.hostRepository.findHostsPaginatedIncludeUser({
      eventTypeId,
      cursor,
      limit,
      search,
    });

    const hosts: AvailabilityHost[] = items.map((item) => ({
      userId: item.userId,
      isFixed: item.isFixed,
      priority: item.priority ?? 0,
      weight: item.weight ?? 100,
      scheduleId: item.scheduleId,
      groupId: item.groupId,
      name: item.user.name,
      avatarUrl: item.user.avatarUrl,
    }));

    return { hosts, nextCursor, hasMore };
  }

  async getHostsForAssignment({
    eventTypeId,
    cursor,
    limit,
    search,
    memberUserIds,
  }: {
    eventTypeId: number;
    cursor?: number;
    limit: number;
    search?: string;
    memberUserIds?: number[];
  }): Promise<PaginatedAssignmentHostsResponse> {
    const { items, nextCursor, hasMore, hasFixedHosts } =
      await this.hostRepository.findHostsPaginatedIncludeUserForAssignment({
        eventTypeId,
        cursor,
        limit,
        search,
        memberUserIds,
      });

    const hosts: AssignmentHost[] = items.map((item) => ({
      userId: item.userId,
      isFixed: item.isFixed,
      priority: item.priority ?? 0,
      weight: item.weight ?? 100,
      scheduleId: item.scheduleId,
      groupId: item.groupId,
      name: item.user.name,
      email: item.user.email,
      avatarUrl: item.user.avatarUrl,
    }));

    return { hosts, nextCursor, hasMore, ...(hasFixedHosts !== undefined && { hasFixedHosts }) };
  }

  async getChildrenForAssignment({
    eventTypeId,
    cursor,
    limit,
    search,
  }: {
    eventTypeId: number;
    cursor?: number;
    limit: number;
    search?: string;
  }): Promise<PaginatedAssignmentChildrenResponse> {
    const { items, nextCursor, hasMore } = await this.hostRepository.findChildrenForAssignmentPaginated({
      eventTypeId,
      cursor,
      limit,
      search,
    });

    const children: AssignmentChild[] = items
      .filter((item) => item.owner !== null)
      .map((item) => ({
        childEventTypeId: item.id,
        slug: item.slug,
        hidden: item.hidden,
        owner: {
          id: item.owner!.id,
          name: item.owner!.name,
          email: item.owner!.email,
          username: item.owner!.username,
          avatarUrl: item.owner!.avatarUrl,
        },
      }));

    return { children, nextCursor, hasMore };
  }

  async searchTeamMembers({
    teamId,
    userId,
    cursor,
    limit,
    search,
    memberUserIds,
  }: {
    teamId: number;
    userId: number;
    cursor?: number | null;
    limit: number;
    search?: string | null;
    memberUserIds?: number[] | null;
  }): Promise<PaginatedTeamMembersResponse> {
    const isMember = await this.membershipRepository.hasMembership({ teamId, userId });
    if (!isMember) {
      if (isOrganizationsEnabled()) {
        throw ErrorWithCode.Factory.NotFound("Team not found");
      }
      throw ErrorWithCode.Factory.Forbidden("You are not a member of this team");
    }

    const { memberships, nextCursor, hasMore } = await this.membershipRepository.searchMembers({
      teamId,
      search,
      cursor,
      limit,
      memberUserIds,
    });

    const members: TeamMemberSearchResult[] = memberships.map((membership) => ({
      userId: membership.user.id,
      name: membership.user.name,
      email: membership.user.email,
      avatarUrl: membership.user.avatarUrl,
      username: membership.user.username,
      defaultScheduleId: membership.user.defaultScheduleId,
      role: membership.role,
    }));

    return { members, nextCursor, hasMore };
  }

  async assertHostsInTeamOrganization({
    teamId,
    hostUserIds,
  }: {
    teamId: number;
    hostUserIds: number[];
  }): Promise<void> {
    if (!isOrganizationsEnabled() || hostUserIds.length === 0) return;

    const team = await this.teamRepository.findBasicById({ teamId });
    const organizationId = team?.isOrganization ? team.id : (team?.parentId ?? null);
    // Org teams let any org member be a host (the handler skips the team-membership
    // check when the team has a parent), so the organization is the isolation boundary.
    if (organizationId === null) return;

    const uniqueIds = Array.from(new Set(hostUserIds));
    const users = await this.userRepository.findOrganizationIdsByIds({ ids: uniqueIds });
    const organizationIdByUserId = new Map(users.map((user) => [user.id, user.organizationId]));

    const badIds = uniqueIds.filter((id) => organizationIdByUserId.get(id) !== organizationId);
    if (badIds.length > 0) {
      throw ErrorWithCode.Factory.NotFound(
        `Unable to assign hosts to team ${teamId}: users ${badIds.join(", ")} are not in organization ${organizationId}`
      );
    }
  }

  async exportHostsForWeights({
    eventTypeId,
    assignAllTeamMembers,
  }: {
    eventTypeId: number;
    assignAllTeamMembers: boolean;
  }): Promise<ExportWeightsResponse> {
    // Derive teamId from the event type to prevent cross-team enumeration
    const eventType = await this.eventTypeRepository.getTeamIdByEventTypeId({ id: eventTypeId });
    const teamId = eventType?.teamId;

    if (assignAllTeamMembers && teamId) {
      const memberships = await this.membershipRepository.findAcceptedMembersWithUserProfile({
        teamId,
      });

      const members: ExportedWeightMember[] = memberships.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
        weight: null,
      }));

      return { members };
    }

    const hosts = await this.hostRepository.findAllRoundRobinHosts({ eventTypeId });

    const members: ExportedWeightMember[] = hosts.map((h) => ({
      userId: h.userId,
      name: h.user.name,
      email: h.user.email,
      avatarUrl: h.user.avatarUrl,
      weight: h.weight ?? 100,
    }));

    return { members };
  }
}
