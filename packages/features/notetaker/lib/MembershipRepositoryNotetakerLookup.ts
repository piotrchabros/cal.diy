import type { MembershipRepository } from "@calcom/features/membership/repositories/MembershipRepository";
import type { INotetakerMembershipLookup, NotetakerMemberRecord } from "./membershipLookup";

type NotetakerMembershipSource = Pick<
  MembershipRepository,
  "hasMembership" | "findAllByUserId" | "searchMembers"
>;

export class MembershipRepositoryNotetakerLookup implements INotetakerMembershipLookup {
  constructor(private readonly membershipRepository: NotetakerMembershipSource) {}

  async isAcceptedMember(params: { userId: number; teamId: number }): Promise<boolean> {
    return this.membershipRepository.hasMembership(params);
  }

  async listAcceptedTeamIds({ userId }: { userId: number }): Promise<number[]> {
    const memberships = await this.membershipRepository.findAllByUserId({
      userId,
      filters: { accepted: true },
    });
    return memberships.map((membership) => membership.teamId);
  }

  async findAcceptedUserIds({ teamId, userIds }: { teamId: number; userIds: number[] }): Promise<number[]> {
    if (userIds.length === 0) return [];
    const { memberships } = await this.membershipRepository.searchMembers({
      teamId,
      limit: userIds.length,
      memberUserIds: userIds,
    });
    return memberships.map((membership) => membership.user.id);
  }

  async searchAcceptedMembers(params: {
    teamId: number;
    search: string | null;
    cursor: number | null;
    limit: number;
  }): Promise<{ items: NotetakerMemberRecord[]; nextCursor: number | null }> {
    const { memberships, nextCursor } = await this.membershipRepository.searchMembers(params);
    // Only these four fields cross the port: the source row also carries username and schedule id.
    const items = memberships.map(({ user }) => ({
      userId: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
    }));
    return { items, nextCursor: nextCursor ?? null };
  }
}
