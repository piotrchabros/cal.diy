import type { NotetakerActivityActionDto, NotetakerActorTypeDto } from "@calcom/lib/dto/NotetakerActivityDto";

export type NotetakerActivityRecord = {
  id: string;
  bookingId: number;
  sessionId: string | null;
  action: NotetakerActivityActionDto;
  actorType: NotetakerActorTypeDto;
  actorUserId: number | null;
  actorName: string | null;
  detail: Record<string, unknown> | null;
  createdAt: Date;
};
export interface INotetakerActivityRepository {
  create(data: Omit<NotetakerActivityRecord, "id" | "createdAt">): Promise<NotetakerActivityRecord>;
  /** Ordered by createdAt desc, then id desc. */
  findByBookingId(params: { bookingId: number; limit: number }): Promise<NotetakerActivityRecord[]>;
  findDistinctActorUserIdsByBookingIdAndAction(params: {
    bookingId: number;
    action: NotetakerActivityActionDto;
  }): Promise<number[]>;
}
