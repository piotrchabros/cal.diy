import { EventRepository } from "@calcom/features/eventtypes/repositories/EventRepository";
import { HashedLinkService } from "@calcom/features/hashedLink/lib/service/HashedLinkService";
import { getHostOrganization } from "@calcom/features/organizations/lib/getHostOrganization";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { getRedirectWithOriginAndSearchString } from "@lib/handleOrgRedirect";
import type { GetServerSidePropsContext } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerSideProps } from "./getServerSideProps";

vi.mock("@calcom/features/organizations/lib/getHostOrganization", () => ({ getHostOrganization: vi.fn() }));
vi.mock("@calcom/features/hashedLink/lib/service/HashedLinkService", () => ({ HashedLinkService: vi.fn() }));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({ UserRepository: vi.fn() }));
vi.mock("@calcom/features/eventtypes/repositories/EventRepository", () => ({
  EventRepository: { getPublicEvent: vi.fn() },
}));
vi.mock("@calcom/features/profile/lib/hideBranding", () => ({
  shouldHideBrandingForTeamEvent: vi.fn(() => false),
  shouldHideBrandingForUserEvent: vi.fn(() => false),
}));
vi.mock("@calcom/features/bookings/lib/get-booking", () => ({
  getBookingForReschedule: vi.fn(),
  getMultipleDurationValue: vi.fn(),
}));
vi.mock("@calcom/features/auth/lib/getServerSession", () => ({ getServerSession: vi.fn() }));
vi.mock("@lib/handleOrgRedirect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/handleOrgRedirect")>()),
  getRedirectWithOriginAndSearchString: vi.fn(),
}));
vi.mock("@calcom/prisma", () => ({ default: {}, prisma: {} }));

type HostOrganization = Awaited<ReturnType<typeof getHostOrganization>>;
type PublicEvent = Awaited<ReturnType<typeof EventRepository.getPublicEvent>>;

const validate = vi.fn();
const findLinkWithDetails = vi.fn();
const findUsersByUsername = vi.fn();

const resolvedHost: HostOrganization = {
  status: "resolved",
  org: { id: 7, slug: "bespokesoft", domain: "bespokesoft.example", isDefault: false },
} as HostOrganization;

const userLink = {
  link: "abc",
  eventTypeId: 1,
  eventType: {
    team: null,
    users: [
      {
        username: "john",
        profiles: [
          { id: 1, organizationId: 3, username: "john-other" },
          { id: 2, organizationId: 7, username: "john-bespoke" },
        ],
      },
    ],
  },
};

const teamLink = (parentId: number | null) => ({
  link: "abc",
  eventTypeId: 1,
  eventType: { team: { id: 5, slug: "sales", parentId }, users: [] },
});

const context = {
  query: { link: "abc", slug: "demo" },
  params: { link: "abc", slug: "demo" },
  req: { headers: {} },
} as unknown as GetServerSidePropsContext;

describe("private link getServerSideProps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(HashedLinkService).mockImplementation(function () {
      return { validate, findLinkWithDetails };
    } as unknown as typeof HashedLinkService);
    vi.mocked(UserRepository).mockImplementation(function () {
      return { findUsersByUsername };
    } as unknown as typeof UserRepository);
    vi.mocked(getHostOrganization).mockResolvedValue({ status: "disabled" });
    vi.mocked(getRedirectWithOriginAndSearchString).mockResolvedValue(null);
    vi.mocked(EventRepository.getPublicEvent).mockResolvedValue({
      entity: {},
      metadata: null,
      length: 30,
    } as unknown as PublicEvent);
    validate.mockResolvedValue(undefined);
    findLinkWithDetails.mockResolvedValue(userLink);
    findUsersByUsername.mockResolvedValue([{ id: 1 }]);
  });

  it("keeps today's lookup when the organizations flag is off", async () => {
    const result = await getServerSideProps(context);

    expect(getRedirectWithOriginAndSearchString).toHaveBeenCalledWith(
      expect.objectContaining({ slugs: ["john"], hostOrgId: null })
    );
    expect(findUsersByUsername).toHaveBeenCalledWith({ usernameList: ["john-other"], orgSlug: null });
    expect(EventRepository.getPublicEvent).toHaveBeenCalledWith(
      expect.objectContaining({ username: "john-other", org: null, isTeamEvent: false }),
      undefined
    );
    expect(result).toHaveProperty("props");
  });

  it("returns 404 for a host without an organization before validating the link", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue({ status: "unresolved" });

    expect(await getServerSideProps(context)).toEqual({ notFound: true });
    expect(validate).not.toHaveBeenCalled();
  });

  it("returns 404 for an invalid link", async () => {
    validate.mockRejectedValue(new Error("expired"));

    expect(await getServerSideProps(context)).toEqual({ notFound: true });
  });

  it("resolves the user through their profile in the host organization", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);

    await getServerSideProps(context);

    expect(getRedirectWithOriginAndSearchString).toHaveBeenCalledWith(
      expect.objectContaining({ hostOrgId: 7 })
    );
    expect(findUsersByUsername).toHaveBeenCalledWith({
      usernameList: ["john-bespoke"],
      orgSlug: "bespokesoft",
    });
    expect(EventRepository.getPublicEvent).toHaveBeenCalledWith(
      expect.objectContaining({ username: "john-bespoke", org: "bespokesoft" }),
      undefined
    );
  });

  it("returns 404 when the user has no profile in the host organization", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    findLinkWithDetails.mockResolvedValue({
      ...userLink,
      eventType: { team: null, users: [{ username: "john", profiles: [] }] },
    });

    expect(await getServerSideProps(context)).toEqual({ notFound: true });
    expect(findUsersByUsername).not.toHaveBeenCalled();
    expect(EventRepository.getPublicEvent).not.toHaveBeenCalled();
  });

  it("serves a team link of a team in the host organization", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    findLinkWithDetails.mockResolvedValue(teamLink(7));

    await getServerSideProps(context);

    expect(EventRepository.getPublicEvent).toHaveBeenCalledWith(
      expect.objectContaining({ username: "sales", isTeamEvent: true, org: "bespokesoft" }),
      undefined
    );
  });

  it.each([null, 9])("returns 404 for a team link whose team parent is %s", async (parentId) => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    findLinkWithDetails.mockResolvedValue(teamLink(parentId));

    expect(await getServerSideProps(context)).toEqual({ notFound: true });
    expect(EventRepository.getPublicEvent).not.toHaveBeenCalled();
  });

  it("redirects a moved user to the private link on the new origin", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    vi.mocked(getRedirectWithOriginAndSearchString).mockResolvedValue({
      origin: "https://acme.example",
      searchString: "?month=2026-11",
    });

    expect(await getServerSideProps(context)).toEqual({
      redirect: { permanent: false, destination: "https://acme.example/d/abc/demo?month=2026-11" },
    });
  });
});
