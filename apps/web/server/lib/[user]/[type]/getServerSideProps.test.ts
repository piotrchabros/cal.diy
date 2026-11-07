import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { EventRepository } from "@calcom/features/eventtypes/repositories/EventRepository";
import { getHostOrganization } from "@calcom/features/organizations/lib/getHostOrganization";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import type { OrgRedirect } from "@lib/handleOrgRedirect";
import { handleOrgRedirect } from "@lib/handleOrgRedirect";
import { getUsersInOrgContext } from "@server/lib/[user]/getServerSideProps";
import type { GetServerSidePropsContext } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerSideProps } from "./getServerSideProps";

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({ getServerSession: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/get-booking", () => ({
  getBookingForReschedule: vi.fn(),
  getBookingForSeatedEvent: vi.fn(),
}));
vi.mock("@calcom/features/eventtypes/repositories/EventRepository", () => ({
  EventRepository: { getPublicEvent: vi.fn() },
}));
vi.mock("@calcom/features/eventtypes/lib/defaultEvents", () => ({
  getUsernameList: (users: string) => users.split("+").filter(Boolean),
}));
vi.mock("@calcom/features/organizations/lib/getHostOrganization", () => ({
  getHostOrganization: vi.fn(),
}));
vi.mock("@calcom/features/profile/lib/hideBranding", () => ({
  shouldHideBrandingForUserEvent: vi.fn(),
}));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({ UserRepository: vi.fn() }));
vi.mock("@calcom/prisma", () => ({ prisma: {} }));
vi.mock("@lib/handleOrgRedirect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/handleOrgRedirect")>()),
  handleOrgRedirect: vi.fn(),
}));
vi.mock("@server/lib/[user]/getServerSideProps", () => ({ getUsersInOrgContext: vi.fn() }));

type PublicEvent = NonNullable<Awaited<ReturnType<typeof EventRepository.getPublicEvent>>>;
type OrgUser = Awaited<ReturnType<typeof getUsersInOrgContext>>[number];
type HostOrganization = Awaited<ReturnType<typeof getHostOrganization>>;

const getPublicEventMock = vi.mocked(EventRepository.getPublicEvent);
const getHostOrganizationMock = vi.mocked(getHostOrganization);
const handleOrgRedirectMock = vi.mocked(handleOrgRedirect);
const getUsersInOrgContextMock = vi.mocked(getUsersInOrgContext);
const findUsersByUsernameMock = vi.fn();

const resolvedHost: HostOrganization = {
  status: "resolved",
  org: { id: 7, slug: "bespokesoft", domain: "bespokesoft.example.com", isDefault: false },
} as HostOrganization;

// The loader only reads these fields; building the full shapes would add noise.
const buildEvent = () => ({ id: 10, metadata: {}, owner: null }) as unknown as PublicEvent;

const buildUser = (orgAllowSEOIndexing: boolean | null = null) =>
  ({
    id: 1,
    allowSEOIndexing: true,
    profile: { organization: { organizationSettings: { allowSEOIndexing: orgAllowSEOIndexing } } },
  }) as unknown as OrgUser;

const buildContext = (user: string, type: string, query: Record<string, string> = {}) =>
  ({
    query: { user, type, ...query },
    params: { user, type },
    req: { headers: {} },
    res: {},
  }) as unknown as GetServerSidePropsContext;

describe("[user]/[type] getServerSideProps", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getHostOrganizationMock.mockResolvedValue({ status: "disabled" });
    vi.mocked(getServerSession).mockResolvedValue(null);
    handleOrgRedirectMock.mockResolvedValue(null);
    getUsersInOrgContextMock.mockResolvedValue([buildUser()]);
    getPublicEventMock.mockResolvedValue(buildEvent());
    findUsersByUsernameMock.mockResolvedValue([buildUser(), buildUser()]);
    // A regular function so it can be called with `new`.
    vi.mocked(UserRepository).mockImplementation(function () {
      return { findUsersByUsername: findUsersByUsernameMock } as unknown as UserRepository;
    });
  });

  describe("single user", () => {
    it("looks the event up off-organization when organizations are disabled", async () => {
      const result = await getServerSideProps(buildContext("alice", "intro", { month: "2026-11" }));

      expect(getUsersInOrgContextMock).toHaveBeenCalledWith(["alice"], null);
      expect(getPublicEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ username: "alice", eventSlug: "intro", org: null }),
        undefined
      );
      expect(handleOrgRedirectMock).toHaveBeenCalledWith(
        expect.objectContaining({ hostOrgId: null, eventTypeSlug: "intro", slugs: ["alice"] })
      );
      expect(result).toHaveProperty("props");
    });

    it("resolves the user and event within the host organization", async () => {
      getHostOrganizationMock.mockResolvedValue(resolvedHost);

      await getServerSideProps(buildContext("alice", "intro", { month: "2026-11" }));

      expect(getUsersInOrgContextMock).toHaveBeenCalledWith(["alice"], "bespokesoft");
      expect(getPublicEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ username: "alice", org: "bespokesoft" }),
        undefined
      );
      expect(handleOrgRedirectMock).toHaveBeenCalledWith(
        expect.objectContaining({ hostOrgId: 7, query: { month: "2026-11" } })
      );
    });

    it("returns notFound without reading the session when the host organization is unresolved", async () => {
      getHostOrganizationMock.mockResolvedValue({ status: "unresolved" });

      expect(await getServerSideProps(buildContext("alice", "intro"))).toEqual({ notFound: true });
      expect(getServerSession).not.toHaveBeenCalled();
      expect(getPublicEventMock).not.toHaveBeenCalled();
    });

    it("passes the organization redirect through", async () => {
      const redirect: OrgRedirect = {
        redirect: { permanent: true, destination: "https://org.example.com/alice/intro" },
      };
      handleOrgRedirectMock.mockResolvedValue(redirect);

      expect(await getServerSideProps(buildContext("alice", "intro"))).toBe(redirect);
      expect(getPublicEventMock).not.toHaveBeenCalled();
    });

    it("is not SEO indexable when the host organization disallows indexing", async () => {
      getHostOrganizationMock.mockResolvedValue(resolvedHost);
      getUsersInOrgContextMock.mockResolvedValue([buildUser(false)]);

      const result = await getServerSideProps(buildContext("alice", "intro"));

      expect(result).toHaveProperty("props.isSEOIndexable", false);
    });
  });

  describe("dynamic group", () => {
    it("looks the users and event up off-organization when organizations are disabled", async () => {
      await getServerSideProps(buildContext("a+b", "intro"));

      expect(findUsersByUsernameMock).toHaveBeenCalledWith({ usernameList: ["a", "b"], orgSlug: null });
      expect(getPublicEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ username: "a+b", eventSlug: "intro", org: null }),
        undefined
      );
      expect(handleOrgRedirectMock).toHaveBeenCalledWith(
        expect.objectContaining({ hostOrgId: null, eventTypeSlug: "intro", slugs: ["a", "b"] })
      );
    });

    it("resolves the users and event within the host organization", async () => {
      getHostOrganizationMock.mockResolvedValue(resolvedHost);

      const result = await getServerSideProps(buildContext("a+b", "intro", { month: "2026-11" }));

      expect(findUsersByUsernameMock).toHaveBeenCalledWith({
        usernameList: ["a", "b"],
        orgSlug: "bespokesoft",
      });
      expect(getPublicEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ username: "a+b", org: "bespokesoft" }),
        undefined
      );
      expect(handleOrgRedirectMock).toHaveBeenCalledWith(
        expect.objectContaining({ hostOrgId: 7, query: { month: "2026-11" } })
      );
      expect(result).toHaveProperty("props");
    });

    it("returns notFound without reading the session when the host organization is unresolved", async () => {
      getHostOrganizationMock.mockResolvedValue({ status: "unresolved" });

      expect(await getServerSideProps(buildContext("a+b", "intro"))).toEqual({ notFound: true });
      expect(getServerSession).not.toHaveBeenCalled();
      expect(getPublicEventMock).not.toHaveBeenCalled();
    });

    it("passes the organization redirect through", async () => {
      const redirect: OrgRedirect = {
        redirect: { permanent: true, destination: "https://org.example.com/a+b/intro" },
      };
      handleOrgRedirectMock.mockResolvedValue(redirect);

      expect(await getServerSideProps(buildContext("a+b", "intro"))).toBe(redirect);
      expect(findUsersByUsernameMock).not.toHaveBeenCalled();
    });
  });
});
