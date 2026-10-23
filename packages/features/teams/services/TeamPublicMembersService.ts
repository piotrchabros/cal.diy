import type { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import type { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import type { PublicTeamMemberDto, PublicTeamMemberEventTypeDto } from "@calcom/lib/dto/PublicTeamMemberDto";
import { PublicTeamMemberDtoSchema } from "@calcom/lib/dto/PublicTeamMemberDto";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import { z } from "zod";

export interface ITeamPublicMembersServiceDeps {
  membershipRepo: Pick<MembershipRepository, "findAcceptedPublicMembersByTeamId">;
  eventTypeRepo: Pick<EventTypeRepository, "findPublicPersonalByUserIds">;
}

export class TeamPublicMembersService {
  constructor(private readonly deps: ITeamPublicMembersServiceDeps) {}

  async listByTeamId({ teamId }: { teamId: number }): Promise<PublicTeamMemberDto[]> {
    const memberships = await this.deps.membershipRepo.findAcceptedPublicMembersByTeamId({ teamId });
    if (memberships.length === 0) return [];

    const users = memberships.map(({ user }) => user);
    const eventTypes = await this.deps.eventTypeRepo.findPublicPersonalByUserIds({
      userIds: users.map((user) => user.id),
    });

    // An event type belongs to its owner and to every co-host in `users`, so index it under each of them.
    const eventTypesByUserId = new Map<number, Map<number, PublicTeamMemberEventTypeDto>>();
    for (const { userId, users: coHosts, ...eventType } of eventTypes) {
      const attributedUserIds = new Set(coHosts.map((coHost) => coHost.id));
      if (userId !== null) attributedUserIds.add(userId);
      for (const attributedUserId of attributedUserIds) {
        const userEventTypes = eventTypesByUserId.get(attributedUserId) ?? new Map();
        userEventTypes.set(eventType.id, {
          id: eventType.id,
          title: eventType.title,
          slug: eventType.slug,
          description: eventType.description,
          length: eventType.length,
        });
        eventTypesByUserId.set(attributedUserId, userEventTypes);
      }
    }

    const members: PublicTeamMemberDto[] = [];
    for (const user of users) {
      const userEventTypes = eventTypesByUserId.get(user.id);
      if (!userEventTypes || !user.username) continue;
      members.push({
        username: user.username,
        name: user.name?.trim() || user.username,
        avatarUrl: getUserAvatarUrl({ avatarUrl: user.avatarUrl }),
        eventTypes: [...userEventTypes.values()],
      });
    }

    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    members.sort((a, b) => collator.compare(a.name, b.name));

    return z.array(PublicTeamMemberDtoSchema).parse(members);
  }
}
