import type { GetServerSidePropsContext } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockFindUnique,
  mockMaybeGetBookingUidFromSeat,
  mockBuildEventUrlFromBooking,
  mockDetermineReschedulePreventionRedirect,
  mockGetOrganizerOrganizationRedirect,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockFindUnique: vi.fn(),
  mockMaybeGetBookingUidFromSeat: vi.fn(),
  mockBuildEventUrlFromBooking: vi.fn(),
  mockDetermineReschedulePreventionRedirect: vi.fn(),
  mockGetOrganizerOrganizationRedirect: vi.fn(),
}));

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: mockGetServerSession,
}));

vi.mock("@calcom/prisma", () => ({
  default: { booking: { findUnique: mockFindUnique } },
  bookingMinimalSelect: {},
}));

vi.mock("@calcom/lib/server/maybeGetBookingUidFromSeat", () => ({
  maybeGetBookingUidFromSeat: mockMaybeGetBookingUidFromSeat,
}));

vi.mock("@calcom/features/users/repositories/UserRepository", () => ({
  UserRepository: class {
    enrichUserWithItsProfile = vi.fn().mockResolvedValue(null);
  },
}));

vi.mock("@calcom/features/bookings/lib/buildEventUrlFromBooking", () => ({
  buildEventUrlFromBooking: mockBuildEventUrlFromBooking,
}));

vi.mock("@calcom/features/bookings/lib/reschedule/determineReschedulePreventionRedirect", () => ({
  determineReschedulePreventionRedirect: mockDetermineReschedulePreventionRedirect,
}));

vi.mock("@calcom/features/organizations/lib/getOrganizerOrganizationRedirect", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@calcom/features/organizations/lib/getOrganizerOrganizationRedirect")
    >();
  return { ...actual, getOrganizerOrganizationRedirect: mockGetOrganizerOrganizationRedirect };
});

import { getServerSideProps } from "./getServerSideProps";

function buildContext(query: Record<string, string>): GetServerSidePropsContext {
  return {
    req: { headers: { host: "app.cal.com" } },
    res: {},
    query,
  } as unknown as GetServerSidePropsContext;
}

const booking = {
  userId: 7,
  startTime: new Date("2030-01-01T10:00:00Z"),
  endTime: new Date("2030-01-01T10:30:00Z"),
  responses: {},
  status: "ACCEPTED",
  dynamicEventSlugRef: null,
  dynamicGroupSlugRef: null,
  user: null,
  eventType: {
    users: [],
    slug: "intro",
    allowReschedulingPastBookings: false,
    disableRescheduling: false,
    allowReschedulingCancelledBookings: false,
    minimumRescheduleNotice: null,
    team: { id: 42, isOrganization: false, parentId: 3, slug: "team" },
    seatsPerTimeSlot: null,
    userId: 7,
    owner: null,
    hosts: [],
  },
};

describe("reschedule getServerSideProps organizer organization redirect", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(null);
    mockMaybeGetBookingUidFromSeat.mockResolvedValue({
      uid: "booking-uid",
      seatReferenceUid: null,
      bookingSeat: null,
    });
    mockFindUnique.mockResolvedValue(booking);
    mockBuildEventUrlFromBooking.mockResolvedValue("https://app.cal.com/team/intro");
    mockDetermineReschedulePreventionRedirect.mockReturnValue(null);
    mockGetOrganizerOrganizationRedirect.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("permanently redirects to the organizer's domain keeping the reschedule query", async () => {
    mockGetOrganizerOrganizationRedirect.mockImplementation(
      async ({ path }: { path: string }) => `https://acme.cal.com${path}`
    );

    const result = await getServerSideProps(
      buildContext({
        uid: "seat-uid",
        seatReferenceUid: "seat-ref",
        rescheduledBy: "a@b.com",
        allowRescheduleForCancelledBooking: "true",
      })
    );

    expect(mockGetOrganizerOrganizationRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        organizerUserId: 7,
        teamId: 42,
        path: "/reschedule/seat-uid?seatReferenceUid=seat-ref&rescheduledBy=a%40b.com&allowRescheduleForCancelledBooking=true",
      })
    );
    expect(mockGetOrganizerOrganizationRedirect.mock.calls[0][0].headers.get("host")).toBe("app.cal.com");
    expect(result).toEqual({
      redirect: {
        destination:
          "https://acme.cal.com/reschedule/seat-uid?seatReferenceUid=seat-ref&rescheduledBy=a%40b.com&allowRescheduleForCancelledBooking=true",
        permanent: true,
      },
    });
  });

  it("drops embed and layout from the path for embedded requests", async () => {
    mockGetOrganizerOrganizationRedirect.mockImplementation(
      async ({ path }: { path: string }) => `https://acme.cal.com${path}`
    );

    await getServerSideProps(
      buildContext({ uid: "booking-uid", embed: "", layout: "month_view", rescheduledBy: "a@b.com" })
    );

    expect(mockGetOrganizerOrganizationRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/reschedule/booking-uid?rescheduledBy=a%40b.com" })
    );
  });

  it("keeps layout when the request is not embedded", async () => {
    await getServerSideProps(buildContext({ uid: "booking-uid", layout: "month_view" }));

    expect(mockGetOrganizerOrganizationRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/reschedule/booking-uid?layout=month_view" })
    );
  });

  it("passes a null team when the booking has no team event type", async () => {
    mockFindUnique.mockResolvedValue({ ...booking, eventType: { ...booking.eventType, team: null } });

    await getServerSideProps(buildContext({ uid: "booking-uid" }));

    expect(mockGetOrganizerOrganizationRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ organizerUserId: 7, teamId: null })
    );
  });

  it("falls through to the existing event URL redirect when no organization redirect applies", async () => {
    const result = await getServerSideProps(buildContext({ uid: "booking-uid", rescheduledBy: "a@b.com" }));

    expect(result).toEqual({
      redirect: {
        destination: "https://app.cal.com/team/intro?rescheduleUid=booking-uid&rescheduledBy=a%40b.com",
        permanent: false,
      },
    });
  });

  it("returns notFound without resolving a redirect when the booking is missing", async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await getServerSideProps(buildContext({ uid: "missing" }));

    expect(result).toEqual({ notFound: true });
    expect(mockGetOrganizerOrganizationRedirect).not.toHaveBeenCalled();
  });
});
