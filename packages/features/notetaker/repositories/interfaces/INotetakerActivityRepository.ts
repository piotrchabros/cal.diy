import type {
  NotetakerActorTypeDto,
  NotetakerStoredActivityActionDto,
} from "@calcom/lib/dto/NotetakerActivityDto";

export type NotetakerActivityRecord = {
  id: string;
  bookingId: number;
  sessionId: string | null;
  action: NotetakerStoredActivityActionDto;
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
    action: NotetakerStoredActivityActionDto;
  }): Promise<number[]>;
  existsByBookingIdAndActionAndActorUserId(params: {
    bookingId: number;
    action: NotetakerStoredActivityActionDto;
    actorUserId: number;
  }): Promise<boolean>;
}
