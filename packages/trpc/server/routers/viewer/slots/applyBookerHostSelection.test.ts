import { SchedulingType } from "@calcom/prisma/enums";
import { describe, expect, it, vi } from "vitest";
import { applyBookerHostSelection } from "./applyBookerHostSelection";

const hostUsers = [
  { id: 1, email: "alice@example.com" },
  { id: 2, email: "bob@example.com" },
  { id: 3, email: "carol@example.com" },
];

const baseEventType = {
  schedulingType: SchedulingType.COLLECTIVE,
  team: { id: 10 },
  metadata: { allowBookerToSelectHosts: true },
  seatsPerTimeSlot: null,
  hosts: hostUsers.map((user) => ({ user })),
};

const fixedHosts = hostUsers.map((user) => ({ user: { id: user.id }, isFixed: true }));

const ids = (hosts: { user: { id: number } }[]) => hosts.map((host) => host.user.id);

describe("applyBookerHostSelection", () => {
  it("narrows fixed hosts to the requested subset when enabled", async () => {
    const findOriginalBooking = vi.fn();
    const result = await applyBookerHostSelection({
      eventType: baseEventType,
      rrHostSubsetIds: [1, 3],
      fixedHosts,
      qualifiedRRHosts: [],
      findOriginalBooking,
    });

    expect(ids(result.fixedHosts)).toEqual([1, 3]);
    expect(result.qualifiedRRHosts).toEqual([]);
    expect(findOriginalBooking).not.toHaveBeenCalled();
  });

  it("ignores the subset and skips the booking lookup when the feature is off", async () => {
    const findOriginalBooking = vi.fn();
    const result = await applyBookerHostSelection({
      eventType: { ...baseEventType, metadata: {} },
      rrHostSubsetIds: [1],
      rescheduleUid: "uid",
      fixedHosts,
      qualifiedRRHosts: [],
      findOriginalBooking,
    });

    expect(ids(result.fixedHosts)).toEqual([1, 2, 3]);
    expect(findOriginalBooking).not.toHaveBeenCalled();
  });

  it("ignores the subset for non-collective events", async () => {
    const result = await applyBookerHostSelection({
      eventType: { ...baseEventType, schedulingType: SchedulingType.ROUND_ROBIN },
      rrHostSubsetIds: [1],
      fixedHosts,
      qualifiedRRHosts: fixedHosts,
      findOriginalBooking: vi.fn(),
    });

    expect(ids(result.fixedHosts)).toEqual([1, 2, 3]);
    expect(ids(result.qualifiedRRHosts)).toEqual([1, 2, 3]);
  });

  it("derives the subset from the original booking on reschedule", async () => {
    const findOriginalBooking = vi.fn().mockResolvedValue({
      userId: 2,
      attendees: [{ email: "Carol@example.com" }, { email: "guest@example.com" }],
    });
    const result = await applyBookerHostSelection({
      eventType: baseEventType,
      rescheduleUid: "reschedule-uid",
      fixedHosts,
      qualifiedRRHosts: [],
      findOriginalBooking,
    });

    expect(findOriginalBooking).toHaveBeenCalledWith("reschedule-uid");
    expect(ids(result.fixedHosts)).toEqual([2, 3]);
  });

  it("prefers an explicit subset over the original booking on reschedule", async () => {
    const findOriginalBooking = vi.fn();
    const result = await applyBookerHostSelection({
      eventType: baseEventType,
      rrHostSubsetIds: [1],
      rescheduleUid: "reschedule-uid",
      fixedHosts,
      qualifiedRRHosts: [],
      findOriginalBooking,
    });

    expect(findOriginalBooking).not.toHaveBeenCalled();
    expect(ids(result.fixedHosts)).toEqual([1]);
  });

  it("keeps all hosts when the original booking is not found", async () => {
    const result = await applyBookerHostSelection({
      eventType: baseEventType,
      rescheduleUid: "missing",
      fixedHosts,
      qualifiedRRHosts: [],
      findOriginalBooking: vi.fn().mockResolvedValue(null),
    });

    expect(ids(result.fixedHosts)).toEqual([1, 2, 3]);
  });
});
