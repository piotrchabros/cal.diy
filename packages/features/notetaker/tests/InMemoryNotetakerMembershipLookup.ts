import type { INotetakerMembershipLookup, NotetakerMemberRecord } from "../lib/membershipLookup";

type StoredMember = NotetakerMemberRecord & { teamId: number; accepted: boolean };

export class InMemoryNotetakerMembershipLookup implements INotetakerMembershipLookup {
  private members: StoredMember[] = [];

  addMember(params: {
    teamId: number;
    userId: number;
    accepted?: boolean;
    name?: string | null;
    email?: string;
    avatarUrl?: string | null;
  }): void {
    const { teamId, userId, accepted = true, name = null, avatarUrl = null } = params;
    this.removeMember({ teamId, userId });
    this.members.push({
      teamId,
      userId,
      accepted,
      name,
      email: params.email ?? `user${userId}@example.com`,
      avatarUrl,
    });
  }

  removeMember({ teamId, userId }: { teamId: number; userId: number }): void {
    this.members = this.members.filter((member) => !(member.teamId === teamId && member.userId === userId));
  }

  async isAcceptedMember({ userId, teamId }: { userId: number; teamId: number }): Promise<boolean> {
    return this.members.some(
      (member) => member.userId === userId && member.teamId === teamId && member.accepted
    );
  }

  async listAcceptedTeamIds({ userId }: { userId: number }): Promise<number[]> {
    return this.members.filter((member) => member.userId === userId && member.accepted).map((m) => m.teamId);
  }

  async findAcceptedUserIds({ teamId, userIds }: { teamId: number; userIds: number[] }): Promise<number[]> {
    if (userIds.length === 0) return [];
    const wanted = new Set(userIds);
    return this.members
      .filter((member) => member.teamId === teamId && member.accepted && wanted.has(member.userId))
      .map((member) => member.userId)
      .sort((a, b) => a - b);
  }

  async searchAcceptedMembers(params: {
    teamId: number;
    search: string | null;
    cursor: number | null;
    limit: number;
  }): Promise<{ items: NotetakerMemberRecord[]; nextCursor: number | null }> {
    const needle = params.search?.toLowerCase() ?? null;
    const matches = this.members
      .filter((member) => member.teamId === params.teamId && member.accepted)
      .filter((member) => params.cursor === null || member.userId > params.cursor)
      .filter(
        (member) =>
          needle === null ||
          (member.name?.toLowerCase().includes(needle) ?? false) ||
          member.email.toLowerCase().includes(needle)
      )
      .sort((a, b) => a.userId - b.userId);
    const page = matches.slice(0, params.limit);
    const items = page.map(({ userId, name, email, avatarUrl }) => ({ userId, name, email, avatarUrl }));
    const nextCursor = matches.length > params.limit ? page[page.length - 1].userId : null;
    return { items, nextCursor };
  }
}
