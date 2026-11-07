import { describe, expect, it } from "vitest";
import { bookingCreateUserId } from "./booking-idempotency-key";

const base = { uid: "b1", title: "Meeting", startTime: new Date(0), endTime: new Date(1) };

describe("bookingCreateUserId", () => {
  it("reads the organizer from a connected user", () => {
    expect(bookingCreateUserId({ ...base, user: { connect: { id: 4 } } })).toBe(4);
  });

  it("reads the organizer from the scalar userId", () => {
    expect(bookingCreateUserId({ ...base, userId: 9 })).toBe(9);
  });

  it("returns undefined without an organizer", () => {
    expect(bookingCreateUserId(base)).toBeUndefined();
    expect(bookingCreateUserId({ ...base, userId: null })).toBeUndefined();
  });
});
