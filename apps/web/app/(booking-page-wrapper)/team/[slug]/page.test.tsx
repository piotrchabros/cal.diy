import { getHostOrganization } from "@calcom/features/organizations/lib/getHostOrganization";
import { handleOrgRedirect } from "@lib/handleOrgRedirect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Page, { generateMetadata } from "./page";

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  permanentRedirect: vi.fn((destination: string) => {
    throw new Error(`REDIRECT:${destination}`);
  }),
}));
vi.mock("@calcom/features/organizations/lib/getHostOrganization", () => ({ getHostOrganization: vi.fn() }));
vi.mock("@calcom/features/teams/di/TeamProfileService.container", () => ({
  getTeamProfileService: () => ({ getPublicTeamBySlug, getPublicOrganizationById }),
}));
vi.mock("@calcom/features/teams/di/TeamPublicMembersService.container", () => ({
  getTeamPublicMembersService: () => ({ listByTeamId: vi.fn(async () => []) }),
}));
vi.mock("@calcom/prisma", () => ({ prisma: {}, default: {} }));
vi.mock("app/_utils", () => ({
  _generateMetadataForStaticPage: vi.fn(async (title: string) => ({ title })),
}));
vi.mock("@calcom/web/modules/teams/views/team-public-view", () => ({ TeamPublicView: () => null }));
vi.mock("@lib/handleOrgRedirect", () => ({ handleOrgRedirect: vi.fn() }));

type HostOrganization = Awaited<ReturnType<typeof getHostOrganization>>;

const resolvedHost = {
  status: "resolved",
  org: { id: 7, slug: "bespokesoft", domain: "bespokesoft.example", isDefault: false },
} as HostOrganization;

const team = { id: 3, name: "BlueBee", slug: "bluebee", bio: null, hideBookATeamMember: true };
const organization = {
  id: 7,
  name: "BespokeSoft",
  slug: "bespokesoft",
  bio: null,
  hideBookATeamMember: true,
};
const { getPublicTeamBySlug, getPublicOrganizationById } = vi.hoisted(() => ({
  getPublicTeamBySlug: vi.fn(),
  getPublicOrganizationById: vi.fn(),
}));

const renderPage = (slug: string, query: Record<string, string> = {}) =>
  Page({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(query) });

describe("team/[slug] page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPublicTeamBySlug.mockResolvedValue(team);
    getPublicOrganizationById.mockResolvedValue(organization);
    vi.mocked(handleOrgRedirect).mockResolvedValue(null);
    vi.mocked(getHostOrganization).mockResolvedValue({ status: "disabled" });
  });

  it("keeps today's lookup when organizations are disabled", async () => {
    await expect(renderPage("BlueBee")).resolves.toBeTruthy();
    expect(getPublicTeamBySlug).toHaveBeenCalledWith({ slug: "BlueBee", parentId: undefined });
    expect(handleOrgRedirect).toHaveBeenCalledWith({
      slugs: ["bluebee"],
      redirectType: "Team",
      eventTypeSlug: null,
      query: {},
      hostOrgId: null,
    });
  });

  it("scopes the team and redirect lookup to the host organization", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    await renderPage("bluebee", { member: "john" });
    expect(getPublicTeamBySlug).toHaveBeenCalledWith({ slug: "bluebee", parentId: 7 });
    expect(handleOrgRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ hostOrgId: 7, query: { member: "john" } })
    );
  });

  it("returns 404 when the host has no organization", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue({ status: "unresolved" });
    await expect(renderPage("bluebee")).rejects.toThrow("NOT_FOUND");
    expect(handleOrgRedirect).not.toHaveBeenCalled();
    expect(getPublicTeamBySlug).not.toHaveBeenCalled();
  });

  it("permanently redirects a team that moved into an organization", async () => {
    vi.mocked(handleOrgRedirect).mockResolvedValue({
      redirect: { permanent: true, destination: "https://acme.example/bluebee" },
    });
    await expect(renderPage("bluebee")).rejects.toThrow("REDIRECT:https://acme.example/bluebee");
    expect(getPublicTeamBySlug).not.toHaveBeenCalled();
  });

  it("returns 404 when the team does not exist", async () => {
    getPublicTeamBySlug.mockResolvedValue(null);
    await expect(renderPage("nope")).rejects.toThrow("NOT_FOUND");
  });

  it("builds metadata from the team in the host organization", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    await expect(
      generateMetadata({ params: Promise.resolve({ slug: "bluebee" }), searchParams: Promise.resolve({}) })
    ).resolves.toEqual({
      title: "BlueBee",
    });
    expect(getPublicTeamBySlug).toHaveBeenCalledWith({ slug: "bluebee", parentId: 7 });
    expect(handleOrgRedirect).not.toHaveBeenCalled();
  });

  it.each([
    "bespokesoft",
    "BespokeSoft",
  ])("looks up the host organization itself by id when the slug is its own (%s)", async (slug) => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    await expect(renderPage(slug)).resolves.toBeTruthy();
    expect(getPublicOrganizationById).toHaveBeenCalledWith({ organizationId: 7 });
    expect(getPublicTeamBySlug).not.toHaveBeenCalled();
  });

  it("does not treat the org slug specially when organizations are disabled", async () => {
    await renderPage("bespokesoft");
    expect(getPublicTeamBySlug).toHaveBeenCalledWith({ slug: "bespokesoft", parentId: undefined });
    expect(getPublicOrganizationById).not.toHaveBeenCalled();
  });

  it("builds metadata from the host organization when the slug is its own", async () => {
    vi.mocked(getHostOrganization).mockResolvedValue(resolvedHost);
    await expect(
      generateMetadata({
        params: Promise.resolve({ slug: "BespokeSoft" }),
        searchParams: Promise.resolve({}),
      })
    ).resolves.toEqual({ title: "BespokeSoft" });
    expect(getPublicOrganizationById).toHaveBeenCalledWith({ organizationId: 7 });
    expect(getPublicTeamBySlug).not.toHaveBeenCalled();
  });
});
