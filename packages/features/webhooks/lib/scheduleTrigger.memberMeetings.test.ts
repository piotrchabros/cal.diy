import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@calcom/features/tasker", () => ({ default: { create: vi.fn(), cancelWithReference: vi.fn() } }));
vi.mock("@calcom/prisma", () => {
  const mockPrisma = {
    team: { findFirst: vi.fn() },
    eventType: { findMany: vi.fn() },
    membership: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
    webhookScheduledTriggers: { create: vi.fn(), deleteMany: vi.fn() },
  };
  return { default: mockPrisma, prisma: mockPrisma };
});

import { prisma } from "@calcom/prisma";
import type { Webhook } from "@calcom/prisma/client";
import { BookingStatus, WebhookTriggerEvents } from "@calcom/prisma/enums";
import { updateTriggerForExistingBookings } from "./scheduleTrigger";

const TEAM_ID = 3;
const startTime = new Date("2099-01-01T10:00:00.000Z");
const endTime = new Date("2099-01-01T11:00:00.000Z");

const webhook = (overrides: Partial<Webhook> = {}) =>
  ({
    id: "wh-1",
    userId: null,
    teamId: TEAM_ID,
    eventTypeId: null,
    subscriberUrl: "https://crm.example.com/hooks/calcom",
    appId: null,
    includeMemberMeetings: true,
    ...overrides,
  }) as Webhook;

const fullBooking = (id: number) => ({ id, uid: `uid-${id}`, startTime, endTime, location: null });

const personalEventType = (sharingTeamId: number | null, userId = 11) => ({
  teamId: null,
  userId,
  team: null,
  notetakerSettings: {
    sharingMode: "TEAM" as const,
    sharingTeam: sharingTeamId === null ? null : { id: sharingTeamId, name: "Sales" },
  },
});

const scheduledBookingIds = () =>
  vi.mocked(prisma.webhookScheduledTriggers.create).mock.calls.map(([args]) => args.data.booking.connect?.id);

describe("updateTriggerForExistingBookings member meetings backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.team.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.eventType.findMany).mockResolvedValue([{ bookings: [fullBooking(1)] }] as never);
    vi.mocked(prisma.membership.findMany).mockResolvedValue([{ userId: 11 }, { userId: 12 }] as never);
  });

  it("schedules MEETING_ENDED for member bookings shared with the team", async () => {
    vi.mocked(prisma.booking.findMany)
      .mockResolvedValueOnce([
        { id: 2, userId: 11, metadata: {}, eventType: personalEventType(TEAM_ID) },
        { id: 3, userId: 12, metadata: { notetakerSharingTeamId: String(TEAM_ID) }, eventType: null },
        { id: 4, userId: 11, metadata: {}, eventType: personalEventType(99) },
      ] as never)
      .mockResolvedValueOnce([fullBooking(2), fullBooking(3)] as never);

    await updateTriggerForExistingBookings(webhook(), [], [WebhookTriggerEvents.MEETING_ENDED]);

    expect(prisma.membership.findMany).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, accepted: true },
      select: { userId: true },
    });
    const candidateWhere = vi.mocked(prisma.booking.findMany).mock.calls[0][0]?.where;
    expect(candidateWhere).toMatchObject({
      status: BookingStatus.ACCEPTED,
      userId: { in: [11, 12] },
      id: { notIn: [1] },
    });
    expect(vi.mocked(prisma.booking.findMany).mock.calls[1][0]).toEqual({ where: { id: { in: [2, 3] } } });
    expect(scheduledBookingIds()).toEqual([1, 2, 3]);
  });

  it("skips a personal event type whose owner is not an accepted member", async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValueOnce([
      { id: 2, userId: 11, metadata: {}, eventType: personalEventType(TEAM_ID, 50) },
    ] as never);

    await updateTriggerForExistingBookings(webhook(), [], [WebhookTriggerEvents.MEETING_ENDED]);

    expect(prisma.booking.findMany).toHaveBeenCalledTimes(1);
    expect(scheduledBookingIds()).toEqual([1]);
  });

  it("does not query members for a team webhook without the flag", async () => {
    await updateTriggerForExistingBookings(
      webhook({ includeMemberMeetings: false }),
      [],
      [WebhookTriggerEvents.MEETING_ENDED]
    );

    expect(prisma.membership.findMany).not.toHaveBeenCalled();
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(scheduledBookingIds()).toEqual([1]);
  });

  it("keeps the team bookings when loading member bookings fails", async () => {
    vi.mocked(prisma.membership.findMany).mockRejectedValue(new Error("db down"));

    await updateTriggerForExistingBookings(webhook(), [], [WebhookTriggerEvents.MEETING_ENDED]);

    expect(scheduledBookingIds()).toEqual([1]);
  });

  it("skips the booking query when the team has no accepted members", async () => {
    vi.mocked(prisma.membership.findMany).mockResolvedValue([]);

    await updateTriggerForExistingBookings(webhook(), [], [WebhookTriggerEvents.MEETING_ENDED]);

    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(scheduledBookingIds()).toEqual([1]);
  });
});

describe("updateTriggerForExistingBookings member meetings toggle", () => {
  const sharedCandidates = [{ id: 2, userId: 11, metadata: {}, eventType: personalEventType(TEAM_ID) }];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.team.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.eventType.findMany).mockResolvedValue([{ bookings: [fullBooking(1)] }] as never);
    vi.mocked(prisma.membership.findMany).mockResolvedValue([{ userId: 11 }] as never);
    vi.mocked(prisma.booking.findMany)
      .mockResolvedValueOnce(sharedCandidates as never)
      .mockResolvedValueOnce([fullBooking(2)] as never);
  });

  it("schedules only member bookings for unchanged triggers when the flag is turned on", async () => {
    const triggers = [WebhookTriggerEvents.MEETING_STARTED, WebhookTriggerEvents.MEETING_ENDED];

    await updateTriggerForExistingBookings(webhook(), triggers, triggers, false);

    expect(scheduledBookingIds()).toEqual([2, 2]);
    expect(prisma.webhookScheduledTriggers.deleteMany).not.toHaveBeenCalled();
  });

  it("does not double-schedule member bookings for a trigger added together with the flag", async () => {
    vi.mocked(prisma.booking.findMany)
      .mockResolvedValueOnce(sharedCandidates as never)
      .mockResolvedValueOnce([fullBooking(2)] as never);

    await updateTriggerForExistingBookings(
      webhook(),
      [WebhookTriggerEvents.MEETING_ENDED],
      [WebhookTriggerEvents.MEETING_ENDED, WebhookTriggerEvents.MEETING_STARTED],
      false
    );

    const payloads = vi
      .mocked(prisma.webhookScheduledTriggers.create)
      .mock.calls.map(
        ([args]) => `${JSON.parse(args.data.payload as string).triggerEvent}:${args.data.booking.connect?.id}`
      );
    expect(payloads.sort()).toEqual(["MEETING_ENDED:2", "MEETING_STARTED:1", "MEETING_STARTED:2"]);
  });

  it("deletes the member booking rows when the flag is turned off", async () => {
    const triggers = [WebhookTriggerEvents.MEETING_ENDED];

    await updateTriggerForExistingBookings(
      webhook({ includeMemberMeetings: false }),
      triggers,
      triggers,
      true
    );

    expect(prisma.webhookScheduledTriggers.deleteMany).toHaveBeenCalledWith({
      where: { webhookId: "wh-1", bookingId: { in: [2] } },
    });
    expect(prisma.webhookScheduledTriggers.create).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.booking.findMany).mock.calls[0][0]?.where).toMatchObject({ id: { notIn: [1] } });
  });

  it("does nothing when the flag is unchanged and the triggers are unchanged", async () => {
    const triggers = [WebhookTriggerEvents.MEETING_ENDED];

    await updateTriggerForExistingBookings(webhook(), triggers, triggers, true);

    expect(prisma.membership.findMany).not.toHaveBeenCalled();
    expect(prisma.webhookScheduledTriggers.create).not.toHaveBeenCalled();
    expect(prisma.webhookScheduledTriggers.deleteMany).not.toHaveBeenCalled();
  });
});
