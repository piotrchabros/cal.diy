import { v5 as uuidv5 } from "uuid";
import { Prisma } from "../client";
import { BookingStatus } from "../enums";

function generateIdempotencyKey({
  startTime,
  endTime,
  userId,
  reassignedById,
}: {
  startTime: Date | string;
  endTime: Date | string;
  userId?: number;
  reassignedById?: number | null;
}) {
  return uuidv5(
    `${startTime.valueOf()}.${endTime.valueOf()}.${userId}${reassignedById ? `.${reassignedById}` : ""}`,
    uuidv5.URL
  );
}

// Bookings created with the scalar `userId` (unchecked input) must hash their organizer too; reading only
// `user.connect.id` made every such booking hash as `undefined`, so two users' bookings at the same time collided
export function bookingCreateUserId(
  data: Prisma.BookingCreateInput | Prisma.BookingUncheckedCreateInput
): number | undefined {
  const scalarUserId = "userId" in data ? data.userId : undefined;
  const connectedUserId = "user" in data ? data.user?.connect?.id : undefined;
  return scalarUserId ?? connectedUserId;
}

export function bookingIdempotencyKeyExtension() {
  return Prisma.defineExtension({
    query: {
      booking: {
        async create({ args, query }) {
          if (args.data.status === BookingStatus.ACCEPTED) {
            const idempotencyKey = generateIdempotencyKey({
              startTime: args.data.startTime,
              endTime: args.data.endTime,
              userId: bookingCreateUserId(args.data),
              reassignedById: args.data.reassignById,
            });
            args.data.idempotencyKey = idempotencyKey;
          }
          return query(args);
        },
        async update({ args, query }) {
          if (args.data.status === BookingStatus.CANCELLED || args.data.status === BookingStatus.REJECTED) {
            args.data.idempotencyKey = null;
          }
          return query(args);
        },
        async updateMany({ args, query }) {
          if (args.data.status === BookingStatus.CANCELLED || args.data.status === BookingStatus.REJECTED) {
            args.data.idempotencyKey = null;
          }
          return query(args);
        },
      },
    },
  });
}
