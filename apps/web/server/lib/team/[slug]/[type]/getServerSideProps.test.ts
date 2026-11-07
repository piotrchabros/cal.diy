import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { getBookingForReschedule } from "@calcom/features/bookings/lib/get-booking";
import { EventRepository } from "@calcom/features/eventtypes/repositories/EventRepository";
import { getHostOrganization } from "@calcom/features/organizations/lib/getHostOrganization";
import { getHideBranding } from "@calcom/features/profile/lib/hideBranding";
import { RedirectType } from "@calcom/prisma/enums";
import { handleOrgRedirect } from "@lib/handleOrgRedirect";
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
vi.mock("@calcom/features/organizations/lib/getHostOrganization", () => ({ getHostOrganization: vi.fn() }));
vi.mock("@calcom/features/profile/lib/hideBranding", () => ({
  getHideBranding: vi.fn(),
  shouldHideBrandingForUserEvent: vi.fn(),
}));
vi.mock("@calcom/features/eventtypes/lib/defaultEvents", () => ({ getUsernameList: vi.fn() }));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({ UserRepository: vi.fn() }));
vi.mock("@calcom/prisma", () => ({ prisma: {} }));
vi.mock("@lib/handleOrgRedirect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/handleOrgRedirect")>()),
  handleOrgRedirect: vi.fn(),
}));
vi.mock("@server/lib/[user]/getServerSideProps", () => ({ getUsersInOrgContext: vi.fn() }));

type PublicEvent = NonNullable<Awaited<ReturnType<typeof EventRepository.getPublicEvent>>>;
type HostOrganization = Awaited<ReturnType<typeof getHostOrganization>>;

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

const resolvedHost: HostOrganization = {
  status: "resolved",
  org: { id: 7, slug: "bespokesoft", domain: "bespokesoft.example", isDefault: false },
} as HostOrganization;

// Only params, query and req are read by the loader. Next.js merges route params into the query,
// so the fixture does too.
const buildContext = (
  params: Record<string, string> | undefined,
  search: Record<string, string> = {}
): GetServerSidePropsContext =>
  ({ params, query: { ...params, ...search }, req: { headers: {} } }) as unknown as GetServerSidePropsContext;

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
    vi.mocked(getHostOrganization).mockResolvedValue({ status: "disabled" });
    vi.mocked(handleOrgRedirect).mockResolvedValue(null);
  });

  it("checks redirects outside any organization when organizations are disabled", async () => {
    getPublicEventMock.mockResolvedValue(buildEvent());

    await getServerSideProps(buildContext({ slug: "BlueBee", type: "intro" }));

    expect(handleOrgRedirect).toHaveBeenCalledWith({
      slugs: ["bluebee"],
      redirectType: RedirectType.TeamEventType,
      eventTypeSlug: "intro",
      query: {},
      hostOrgId: null,
    });
    expect(getPublicEventMock).toHaveBeenCalledWith(expect.objectContaining({ org: null }), undefined);
  });

  it("looks the event up within the host organization", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    getPublicEventMock.mockResolvedValue(buildEvent());

    const result = await getServerSideProps(
      buildContext({ slug: "BlueBee", type: "intro" }, { month: "2026-11" })
    );

    expect(handleOrgRedirect).toHaveBeenCalledWith({
      slugs: ["bluebee"],
      redirectType: RedirectType.TeamEventType,
      eventTypeSlug: "intro",
      query: { month: "2026-11" },
      hostOrgId: 7,
    });
    expect(getPublicEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ username: "bluebee", org: "bespokesoft" }),
      undefined
    );
    expect(result).toHaveProperty("props");
  });

  it("returns notFound for an unresolved host without reading the session or the event", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue({ status: "unresolved" });

    const result = await getServerSideProps(buildContext({ slug: "BlueBee", type: "intro" }));

    expect(result).toEqual({ notFound: true });
    expect(handleOrgRedirect).not.toHaveBeenCalled();
    expect(getServerSession).not.toHaveBeenCalled();
    expect(getPublicEventMock).not.toHaveBeenCalled();
  });

  it("returns the organization redirect unchanged without looking the event up", async () => {
    const redirect = {
      redirect: { permanent: true, destination: "https://other.example/team/intro" },
    } as const;
    vi.mocked(handleOrgRedirect).mockResolvedValue(redirect);

    const result = await getServerSideProps(buildContext({ slug: "BlueBee", type: "intro" }));

    expect(result).toBe(redirect);
    expect(getPublicEventMock).not.toHaveBeenCalled();
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
