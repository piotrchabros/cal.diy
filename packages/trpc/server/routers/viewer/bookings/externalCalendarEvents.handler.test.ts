import type { ExternalCalendarEventsDto } from "@calcom/lib/dto/ExternalCalendarEventDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { externalCalendarEventsHandler } from "./externalCalendarEvents.handler";
import { ZExternalCalendarEventsInputSchema } from "./externalCalendarEvents.schema";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@calcom/features/external-calendar-events/di/ExternalCalendarEventsService.container", () => ({
  getExternalCalendarEventsService: () => ({ list: mocks.list }),
}));

const user = { id: 7, email: "me@example.com" } as NonNullable<TrpcSessionUser>;
const from = new Date("2026-11-04T10:00:00.000Z");
const to = new Date("2026-11-11T10:00:00.000Z");
const dto: ExternalCalendarEventsDto = {
  available: true,
  events: [
    {
      key: "sc-1:ext-1",
      title: "Standup",
      start: from,
      end: new Date(from.getTime() + 60 * 60 * 1000),
      isAllDay: false,
      status: "confirmed",
      selfResponse: "accepted",
      attendeesCount: 2,
      meetingUrl: null,
      meetingPlatform: null,
      calendar: { selectedCalendarId: "sc-1", integration: "google_calendar", externalId: "a@b.c" },
    },
  ],
  failedCalendarCount: 0,
};

describe("externalCalendarEventsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue(dto);
  });

  it("calls list once with the viewer taken from ctx and the range from input", async () => {
    await externalCalendarEventsHandler({ ctx: { user }, input: { from, to } });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({ userId: 7, userEmail: "me@example.com", from, to });
  });

  it("returns the service result unchanged", async () => {
    expect(await externalCalendarEventsHandler({ ctx: { user }, input: { from, to } })).toBe(dto);
  });

  it("propagates service errors unchanged", async () => {
    const error = ErrorWithCode.Factory.BadRequest("INVALID_RANGE");
    mocks.list.mockRejectedValue(error);

    await expect(externalCalendarEventsHandler({ ctx: { user }, input: { from, to } })).rejects.toBe(error);
  });
});

describe("ZExternalCalendarEventsInputSchema", () => {
  it("accepts a range of up to 8 days", () => {
    expect(ZExternalCalendarEventsInputSchema.safeParse({ from, to }).success).toBe(true);
    expect(
      ZExternalCalendarEventsInputSchema.safeParse({
        from,
        to: new Date(from.getTime() + 8 * 24 * 60 * 60 * 1000),
      }).success
    ).toBe(true);
  });

  it("rejects an empty, reversed or too long range", () => {
    expect(ZExternalCalendarEventsInputSchema.safeParse({ from, to: from }).success).toBe(false);
    expect(ZExternalCalendarEventsInputSchema.safeParse({ from: to, to: from }).success).toBe(false);
    expect(
      ZExternalCalendarEventsInputSchema.safeParse({
        from,
        to: new Date(from.getTime() + 8 * 24 * 60 * 60 * 1000 + 1),
      }).success
    ).toBe(false);
  });

  it("rejects non-date values", () => {
    expect(ZExternalCalendarEventsInputSchema.safeParse({ from: from.toISOString(), to }).success).toBe(
      false
    );
  });
});
