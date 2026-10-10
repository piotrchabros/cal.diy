export type NotetakerMemberRecord = {
  userId: number;
  name: string | null;
  email: string;
  avatarUrl: string | null;
};

export interface INotetakerMembershipLookup {
  isAcceptedMember(params: { userId: number; teamId: number }): Promise<boolean>;
  listAcceptedTeamIds(params: { userId: number }): Promise<number[]>;
  /** The subset of userIds that are accepted members of the team. Empty input gives [] without a query. */
  findAcceptedUserIds(params: { teamId: number; userIds: number[] }): Promise<number[]>;
  /** Ordered by user id asc; cursor is the last user id of the previous page. */
  searchAcceptedMembers(params: {
    teamId: number;
    search: string | null;
    cursor: number | null;
    limit: number;
  }): Promise<{ items: NotetakerMemberRecord[]; nextCursor: number | null }>;
}
