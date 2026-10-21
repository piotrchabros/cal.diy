import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { getBookingForReschedule } from "@calcom/features/bookings/lib/get-booking";
import { EventRepository } from "@calcom/features/eventtypes/repositories/EventRepository";
import { getHideBranding } from "@calcom/features/profile/lib/hideBranding";
import type { GetServerSidePropsContext } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEventSlugCandidates, getServerSideProps } from "./getServerSideProps";

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({ getServerSession: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/get-booking", () => ({
  getBookingForReschedule: vi.fn(),
  getBookingForSeatedEvent: vi.fn(),
}));
vi.mock("@calcom/features/eventtypes/repositories/EventRepository", () => ({
  EventRepository: { getPublicEvent: vi.fn() },
}));
vi.mock("@calcom/features/profile/lib/hideBranding", () => ({
  getHideBranding: vi.fn(),
  shouldHideBrandingForUserEvent: vi.fn(),
}));
vi.mock("@calcom/features/eventtypes/lib/defaultEvents", () => ({ getUsernameList: vi.fn() }));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({ UserRepository: vi.fn() }));
vi.mock("@calcom/prisma", () => ({ prisma: {} }));
vi.mock("@lib/handleOrgRedirect", () => ({ handleOrgRedirect: vi.fn() }));
vi.mock("@server/lib/[user]/getServerSideProps", () => ({ getUsersInOrgContext: vi.fn() }));

type PublicEvent = NonNullable<Awaited<ReturnType<typeof EventRepository.getPublicEvent>>>;

const getPublicEventMock = vi.mocked(EventRepository.getPublicEvent);

// The loader only reads these fields of the public event; building the full shape would add noise.
const buildEvent = (overrides: Partial<{ teamId: number | null; slug: string; hidden: boolean }> = {}) =>
  ({
    id: 10,
    slug: "stored-slug",
    teamId: 5,
    hidden: false,
    team: { slug: "stored-team" },
    ...overrides,
  }) as unknown as PublicEvent;

// Only params, query and req are read by the loader.
const buildContext = (
  params: Record<string, string> | undefined,
  query: Record<string, string> = {}
): GetServerSidePropsContext => ({ params, query, req: {} }) as unknown as GetServerSidePropsContext;

describe("getEventSlugCandidates", () => {
  it("returns a single candidate when the raw and slugified forms match", () => {
    expect(getEventSlugCandidates("spotkanie-zespołowe")).toEqual(["spotkanie-zespołowe"]);
  });

  it("returns the trimmed raw value and its slugified form", () => {
    const candidates = getEventSlugCandidates("Spotkanie Ó");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe("Spotkanie Ó");
    expect(candidates[1]).not.toBe(candidates[0]);
  });

  it("removes duplicates and empty candidates", () => {
    expect(getEventSlugCandidates("  abc  ")).toEqual(["abc"]);
    expect(getEventSlugCandidates("   ")).toEqual([]);
  });
});

describe("team type getServerSideProps", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerSession).mockResolvedValue(null);
    vi.mocked(getHideBranding).mockResolvedValue(false);
    getPublicEventMock.mockResolvedValue(null);
  });

  it("looks the event up as a team event with the slugified team slug", async () => {
    getPublicEventMock.mockResolvedValue(buildEvent());

    await getServerSideProps(buildContext({ slug: "BlueBee", type: "intro" }));

    expect(getPublicEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ username: "bluebee", eventSlug: "intro", isTeamEvent: true, org: null }),
      undefined
    );
  });

  it("falls back to the slugified candidate when the raw one finds nothing", async () => {
    const [raw, slugified] = getEventSlugCandidates("Spotkanie Ó");
    getPublicEventMock.mockImplementation(async ({ eventSlug }) =>
      eventSlug === slugified ? buildEvent() : null
    );

    const result = await getServerSideProps(buildContext({ slug: "team", type: "Spotkanie Ó" }));

    expect(getPublicEventMock.mock.calls.map(([args]) => args.eventSlug)).toEqual([raw, slugified]);
    expect(result).toHaveProperty("props");
  });

  it("returns notFound when every lookup returns null", async () => {
    const result = await getServerSideProps(buildContext({ slug: "team", type: "Spotkanie Ó" }));

    expect(result).toEqual({ notFound: true });
    expect(getPublicEventMock).toHaveBeenCalledTimes(2);
  });

  it("returns notFound when the event does not belong to a team", async () => {
    getPublicEventMock.mockResolvedValue(buildEvent({ teamId: null }));

    expect(await getServerSideProps(buildContext({ slug: "team", type: "intro" }))).toEqual({
      notFound: true,
    });
  });

  it.each([
    ["missing params", undefined],
    ["empty slug", { slug: "", type: "intro" }],
    ["empty type", { slug: "team", type: "" }],
    ["slug that slugifies to nothing", { slug: "!!!", type: "intro" }],
  ])("returns notFound for %s", async (_name, params) => {
    expect(await getServerSideProps(buildContext(params))).toEqual({ notFound: true });
    expect(getPublicEventMock).not.toHaveBeenCalled();
  });

  it("returns the page props built from the stored event", async () => {
    const eventData = buildEvent();
    getPublicEventMock.mockResolvedValue(eventData);
    vi.mocked(getHideBranding).mockResolvedValue(true);

    const result = await getServerSideProps(buildContext({ slug: "BlueBee", type: "intro" }));

    expect(getHideBranding).toHaveBeenCalledWith({ teamId: 5 });
    expect(result).toEqual({
      props: {
        eventData,
        user: "stored-team",
        slug: "stored-slug",
        isTeamEvent: true,
        isBrandingHidden: true,
        isSEOIndexable: true,
        bookingUid: null,
        rescheduleUid: null,
        orgBannerUrl: null,
      },
    });
  });

  it("still returns a hidden event so it stays bookable by direct link", async () => {
    getPublicEventMock.mockResolvedValue(buildEvent({ hidden: true }));

    const result = await getServerSideProps(buildContext({ slug: "team", type: "intro" }));

    expect(result).toHaveProperty("props");
  });

  it("redirects to the booking page when rescheduling is disabled for the event type", async () => {
    getPublicEventMock.mockResolvedValue(buildEvent());
    vi.mocked(getBookingForReschedule).mockResolvedValue({
      eventType: { disableRescheduling: true },
    } as unknown as Awaited<ReturnType<typeof getBookingForReschedule>>);

    const result = await getServerSideProps(
      buildContext({ slug: "team", type: "intro" }, { rescheduleUid: "abc123" })
    );

    expect(result).toEqual({ redirect: { destination: "/booking/abc123", permanent: false } });
  });
});
