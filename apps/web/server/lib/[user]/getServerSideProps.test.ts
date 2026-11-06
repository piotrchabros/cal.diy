import { getEventTypesPublic } from "@calcom/features/eventtypes/lib/getEventTypesPublic";
import { getHostOrganization } from "@calcom/features/organizations/lib/getHostOrganization";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { RedirectType } from "@calcom/prisma/enums";
import { handleOrgRedirect } from "@lib/handleOrgRedirect";
import type { GetServerSidePropsContext } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerSideProps } from "./getServerSideProps";

vi.mock("@calcom/features/organizations/lib/getHostOrganization", () => ({ getHostOrganization: vi.fn() }));
vi.mock("@lib/handleOrgRedirect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/handleOrgRedirect")>()),
  handleOrgRedirect: vi.fn(),
}));
vi.mock("@calcom/features/users/repositories/UserRepository", () => ({ UserRepository: vi.fn() }));
vi.mock("@calcom/features/eventtypes/lib/getEventTypesPublic", () => ({ getEventTypesPublic: vi.fn() }));
vi.mock("@calcom/prisma", () => ({ prisma: {}, default: {} }));

type HostOrganization = Awaited<ReturnType<typeof getHostOrganization>>;
type FoundUsers = Awaited<ReturnType<UserRepository["findUsersByUsername"]>>;
type EventTypes = Awaited<ReturnType<typeof getEventTypesPublic>>;

const findUsersByUsername = vi.fn();
const findPlatformMembersByUsernames = vi.fn();

const resolvedHost: HostOrganization = {
  status: "resolved",
  org: { id: 7, slug: "bespokesoft", domain: "bespokesoft.example", isDefault: false },
} as HostOrganization;

// The loader only reads these user fields; the full repository shape would add noise.
const buildUser = (username: string, organization: { id: number; slug: string } | null = null) =>
  ({
    id: 1,
    name: username,
    username,
    bio: null,
    avatarUrl: null,
    verified: false,
    allowSEOIndexing: true,
    theme: null,
    brandColor: null,
    darkBrandColor: null,
    profile: {
      username,
      organization: organization
        ? {
            ...organization,
            name: "Bespokesoft",
            logoUrl: null,
            brandColor: null,
            darkBrandColor: null,
            theme: null,
            organizationSettings: null,
          }
        : null,
    },
  }) as unknown as FoundUsers[number];

const buildContext = (user: string, search: Record<string, string> = {}): GetServerSidePropsContext =>
  ({
    query: { user, ...search },
    params: { user },
    req: { headers: {} },
    res: { setHeader: vi.fn() },
  }) as unknown as GetServerSidePropsContext;

describe("user page getServerSideProps", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(UserRepository).mockImplementation(
      class {
        findUsersByUsername = findUsersByUsername;
        findPlatformMembersByUsernames = findPlatformMembersByUsernames;
      } as unknown as typeof UserRepository
    );
    vi.mocked(getHostOrganization).mockResolvedValue({ status: "disabled" });
    vi.mocked(handleOrgRedirect).mockResolvedValue(null);
    vi.mocked(getEventTypesPublic).mockResolvedValue([] as EventTypes);
    findUsersByUsername.mockResolvedValue([]);
    findPlatformMembersByUsernames.mockResolvedValue([]);
  });

  describe("with organizations disabled", () => {
    it("looks users up outside any organization and renders a non-org user", async () => {
      findUsersByUsername.mockResolvedValue([buildUser("john")]);

      const result = await getServerSideProps(buildContext("john"));

      expect(handleOrgRedirect).toHaveBeenCalledWith(expect.objectContaining({ hostOrgId: null }));
      expect(findUsersByUsername).toHaveBeenCalledWith({ usernameList: ["john"], orgSlug: null });
      expect(result).toHaveProperty("props");
      if (!("props" in result)) return;
      const props = await result.props;
      expect(props.entity.orgSlug).toBeNull();
      expect(props.users.map((user) => user.username)).toEqual(["john"]);
    });

    it("falls back to the platform member search when nobody is found", async () => {
      const result = await getServerSideProps(buildContext("john"));

      expect(findPlatformMembersByUsernames).toHaveBeenCalledWith({ usernameList: ["john"] });
      expect(result).toEqual({ notFound: true });
    });
  });

  describe("on an organization domain", () => {
    beforeEach(() => {
      vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    });

    it("checks redirects and looks users up within the host organization", async () => {
      findUsersByUsername.mockResolvedValue([buildUser("john", { id: 7, slug: "bespokesoft" })]);

      const result = await getServerSideProps(buildContext("john", { redirect: "false" }));

      expect(handleOrgRedirect).toHaveBeenCalledWith({
        slugs: ["john"],
        redirectType: RedirectType.User,
        eventTypeSlug: null,
        query: { redirect: "false" },
        hostOrgId: 7,
      });
      expect(findUsersByUsername).toHaveBeenCalledWith({ usernameList: ["john"], orgSlug: "bespokesoft" });
      expect(result).toHaveProperty("props");
      if (!("props" in result)) return;
      const props = await result.props;
      expect(props.entity.orgSlug).toBe("bespokesoft");
      expect(props.profile.organization).toEqual(expect.objectContaining({ id: 7, slug: "bespokesoft" }));
    });

    it("returns the organization redirect unchanged without looking users up", async () => {
      const redirect = { redirect: { permanent: true, destination: "https://other.example/john" } } as const;
      vi.mocked(handleOrgRedirect).mockResolvedValue(redirect);

      const result = await getServerSideProps(buildContext("john"));

      expect(result).toBe(redirect);
      expect(findUsersByUsername).not.toHaveBeenCalled();
    });

    it("returns notFound without the platform fallback when nobody is found", async () => {
      const result = await getServerSideProps(buildContext("john"));

      expect(result).toEqual({ notFound: true });
      expect(findPlatformMembersByUsernames).not.toHaveBeenCalled();
    });

    it("redirects a group of users to the dynamic group page", async () => {
      findUsersByUsername.mockResolvedValue([
        buildUser("a", { id: 7, slug: "bespokesoft" }),
        buildUser("b", { id: 7, slug: "bespokesoft" }),
      ]);

      const result = await getServerSideProps(buildContext("a+b"));

      expect(result).toEqual({
        redirect: { permanent: false, destination: expect.stringMatching(/^\/a\+b\/dynamic\?/) },
      });
    });

    it("redirects to the only public event type", async () => {
      findUsersByUsername.mockResolvedValue([buildUser("john", { id: 7, slug: "bespokesoft" })]);
      vi.mocked(getEventTypesPublic).mockResolvedValue([{ slug: "intro" }] as unknown as EventTypes);

      const result = await getServerSideProps(buildContext("john"));

      expect(result).toEqual({
        redirect: { permanent: false, destination: expect.stringMatching(/^\/john\/intro\?/) },
      });
    });
  });

  it("returns notFound for an unresolved host without checking redirects or users", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue({ status: "unresolved" });

    const result = await getServerSideProps(buildContext("john"));

    expect(result).toEqual({ notFound: true });
    expect(handleOrgRedirect).not.toHaveBeenCalled();
    expect(findUsersByUsername).not.toHaveBeenCalled();
  });
});
