import type { GetServerSidePropsContext } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockGetBookingInfo,
  mockMaybeGetBookingUidFromSeat,
  mockGetEventTypesFromDB,
  mockGetOrganizerOrganizationRedirect,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockGetBookingInfo: vi.fn(),
  mockMaybeGetBookingUidFromSeat: vi.fn(),
  mockGetEventTypesFromDB: vi.fn(),
  mockGetOrganizerOrganizationRedirect: vi.fn(),
}));

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: mockGetServerSession,
}));

vi.mock("@lib/booking", () => ({
  getEventTypesFromDB: mockGetEventTypesFromDB,
  getRecurringBookings: vi.fn(),
  handleSeatsEventTypeOnBooking: vi.fn(),
}));

vi.mock("@calcom/features/bookings/lib/getBookingInfo", () => ({
  default: mockGetBookingInfo,
}));

vi.mock("@calcom/lib/server/maybeGetBookingUidFromSeat", () => ({
  maybeGetBookingUidFromSeat: mockMaybeGetBookingUidFromSeat,
}));

vi.mock("@calcom/prisma", () => ({ default: {}, prisma: {} }));

vi.mock("app/_trpc/context", () => ({ createRouterCaller: vi.fn() }));

vi.mock("@calcom/trpc/server/routers/viewer/me/_router", () => ({ meRouter: {} }));

vi.mock("@calcom/features/organizations/lib/getOrganizerOrganizationRedirect", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@calcom/features/organizations/lib/getOrganizerOrganizationRedirect")
    >();
  return { ...actual, getOrganizerOrganizationRedirect: mockGetOrganizerOrganizationRedirect };
});

import { getServerSideProps } from "./bookings-single-view.getServerSideProps";

function buildContext(query: Record<string, string>): GetServerSidePropsContext {
  return {
    req: { headers: { host: "app.cal.com" } },
    res: {},
    query,
  } as unknown as GetServerSidePropsContext;
}

const bookingUser = {
  id: 7,
  name: "Organizer",
  email: "o@cal.com",
  username: "o",
  timeZone: "UTC",
  avatarUrl: null,
};

function mockBooking(user: typeof bookingUser | null = bookingUser) {
  mockGetBookingInfo.mockResolvedValue({
    bookingInfoRaw: { eventTypeId: 11, user },
    bookingInfo: {
      uid: "booking-uid",
      rescheduled: false,
      fromReschedule: null,
      startTime: new Date("2030-01-01T10:00:00Z"),
      endTime: new Date("2030-01-01T10:30:00Z"),
    },
  });
}

function mockEventType(overrides: Record<string, unknown> = {}) {
  mockGetEventTypesFromDB.mockResolvedValue({
    seatsPerTimeSlot: null,
    hosts: [],
    users: [],
    owner: null,
    team: null,
    parent: null,
    ...overrides,
  });
}

describe("booking page getServerSideProps organizer organization redirect", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(null);
    mockMaybeGetBookingUidFromSeat.mockResolvedValue({ uid: null, seatReferenceUid: null });
    mockBooking();
    mockEventType();
    // Stopping at the redirect keeps these tests independent of the rest of the page's data loading.
    mockGetOrganizerOrganizationRedirect.mockResolvedValue("https://acme.cal.com/booking/booking-uid");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("permanently redirects using the original seat uid and keeps the other query params", async () => {
    mockMaybeGetBookingUidFromSeat.mockResolvedValue({ uid: "booking-uid", seatReferenceUid: "seat-uid" });
    mockGetOrganizerOrganizationRedirect.mockImplementation(
      async ({ path }: { path: string }) => `https://acme.cal.com${path}`
    );

    const result = await getServerSideProps(
      buildContext({ uid: "seat-uid", email: "a@b.com", isSuccessBookingPage: "true" })
    );

    expect(mockGetOrganizerOrganizationRedirect.mock.calls[0][0].headers.get("host")).toBe("app.cal.com");
    expect(result).toEqual({
      redirect: {
        destination: "https://acme.cal.com/booking/seat-uid?email=a%40b.com&isSuccessBookingPage=true",
        permanent: true,
      },
    });
  });

  it("drops embed and layout from the path for embedded requests", async () => {
    await getServerSideProps(
      buildContext({ uid: "booking-uid", embed: "", layout: "month_view", email: "a@b.com" })
    );

    expect(mockGetOrganizerOrganizationRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/booking/booking-uid?email=a%40b.com" })
    );
  });

  it("keeps layout when the request is not embedded", async () => {
    await getServerSideProps(buildContext({ uid: "booking-uid", layout: "month_view" }));

    expect(mockGetOrganizerOrganizationRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/booking/booking-uid?layout=month_view" })
    );
  });

  it("passes the booking organizer and the event type's team", async () => {
    mockEventType({ team: { id: 42 }, parent: { teamId: 99 } });

    await getServerSideProps(buildContext({ uid: "booking-uid" }));

    expect(mockGetOrganizerOrganizationRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ organizerUserId: 7, teamId: 42 })
    );
  });

  it("falls back to the parent event type's team for managed event types", async () => {
    mockEventType({ team: null, parent: { teamId: 99 } });

    await getServerSideProps(buildContext({ uid: "booking-uid" }));

    expect(mockGetOrganizerOrganizationRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ organizerUserId: 7, teamId: 99 })
    );
  });

  it("continues rendering when no organization redirect applies", async () => {
    mockBooking(null);
    mockGetOrganizerOrganizationRedirect.mockResolvedValue(null);

    const result = await getServerSideProps(buildContext({ uid: "booking-uid" }));

    expect(mockGetOrganizerOrganizationRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ organizerUserId: null, teamId: null })
    );
    expect(result).toEqual({ notFound: true });
  });

  it("returns notFound without resolving a redirect when the booking is missing", async () => {
    mockGetBookingInfo.mockResolvedValue({ bookingInfoRaw: undefined, bookingInfo: undefined });

    const result = await getServerSideProps(buildContext({ uid: "missing" }));

    expect(result).toEqual({ notFound: true });
    expect(mockGetOrganizerOrganizationRedirect).not.toHaveBeenCalled();
  });
});
