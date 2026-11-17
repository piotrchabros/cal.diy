import type { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import type { HostRepository } from "@calcom/features/host/repositories/HostRepository";
import type { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import { SchedulingType } from "@calcom/prisma/enums";

export interface IAssignAllTeamMembersHostServiceDeps {
  hostRepository: Pick<HostRepository, "createManyIgnoringDuplicates" | "deleteByUserIdAndTeamIds">;
  eventTypeRepository: Pick<EventTypeRepository, "findAssignAllHostedByTeamIds">;
  membershipRepository: Pick<MembershipRepository, "listAcceptedTeamMemberIds">;
}

// Same defaults the event type create handler and the assignment UI use for new hosts.
const DEFAULT_HOST_PRIORITY = 2;
const DEFAULT_HOST_WEIGHT = 100;

function buildHostRow({
  userId,
  eventTypeId,
  schedulingType,
}: {
  userId: number;
  eventTypeId: number;
  schedulingType: SchedulingType;
}) {
  return {
    userId,
    eventTypeId,
    isFixed: schedulingType === SchedulingType.COLLECTIVE,
    priority: DEFAULT_HOST_PRIORITY,
    weight: DEFAULT_HOST_WEIGHT,
  };
}

/**
 * Booking and slot lookups only read Host rows, so event types with assignAllTeamMembers
 * need a Host row for every accepted team member to actually include them.
 */
export class AssignAllTeamMembersHostService {
  constructor(private readonly deps: IAssignAllTeamMembersHostServiceDeps) {}

  async syncEventType({
    eventTypeId,
    teamId,
    schedulingType,
  }: {
    eventTypeId: number;
    teamId: number;
    schedulingType: SchedulingType | null;
  }): Promise<{ added: number }> {
    // Managed event types assign members through child event types, not Host rows.
    if (!schedulingType || schedulingType === SchedulingType.MANAGED) return { added: 0 };

    const memberIds = await this.deps.membershipRepository.listAcceptedTeamMemberIds({ teamId });
    const rows = memberIds.map((userId) => buildHostRow({ userId, eventTypeId, schedulingType }));
    const added = await this.deps.hostRepository.createManyIgnoringDuplicates(rows);
    return { added };
  }

  async addMemberToTeams({
    userId,
    teamIds,
  }: {
    userId: number;
    teamIds: number[];
  }): Promise<{ added: number }> {
    if (teamIds.length === 0) return { added: 0 };

    const eventTypes = await this.deps.eventTypeRepository.findAssignAllHostedByTeamIds({ teamIds });
    const rows = eventTypes.map((eventType) =>
      buildHostRow({ userId, eventTypeId: eventType.id, schedulingType: eventType.schedulingType })
    );
    const added = await this.deps.hostRepository.createManyIgnoringDuplicates(rows);
    return { added };
  }

  async removeMemberFromTeams({
    userId,
    teamIds,
  }: {
    userId: number;
    teamIds: number[];
  }): Promise<{ removed: number }> {
    if (teamIds.length === 0) return { removed: 0 };

    const removed = await this.deps.hostRepository.deleteByUserIdAndTeamIds({ userId, teamIds });
    return { removed };
  }
}
