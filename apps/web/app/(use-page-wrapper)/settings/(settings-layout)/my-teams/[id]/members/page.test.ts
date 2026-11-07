import { MembershipRole } from "@calcom/prisma/enums";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  findBasicById: vi.fn(),
  findRoleAndAcceptedByUserIdAndTeamId: vi.fn(),
  getRole: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({})),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  redirect: vi.fn((destination: string) => {
    throw new Error(`REDIRECT:${destination}`);
  }),
}));
vi.mock("@lib/buildLegacyCtx", () => ({ buildLegacyRequest: vi.fn(() => ({})) }));
vi.mock("app/_utils", () => ({ _generateMetadata: vi.fn() }));
vi.mock("@calcom/web/modules/settings/teams/members-view", () => ({ default: () => null }));
vi.mock("@calcom/features/auth/lib/getServerSession", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@calcom/features/teams/di/TeamRepository.container", () => ({
  getTeamRepository: () => ({ findBasicById: mocks.findBasicById }),
}));
vi.mock("@calcom/features/users/di/MembershipRepository.container", () => ({
  getMembershipRepository: () => ({
    findRoleAndAcceptedByUserIdAndTeamId: mocks.findRoleAndAcceptedByUserIdAndTeamId,
  }),
}));
vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ getRole: mocks.getRole }),
}));

import Page from "./page";

type MembersViewProps = { teamId: number; viewerId: number; canManage: boolean; isPendingInvite: boolean };

const renderPage = async (id = "3") =>
  (await Page({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve({}),
  })) as ReactElement<MembersViewProps>;

describe("my-teams/[id]/members page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSession.mockResolvedValue({ user: { id: 7 } });
    mocks.findBasicById.mockResolvedValue({ id: 3, parentId: 1, isOrganization: false });
    mocks.findRoleAndAcceptedByUserIdAndTeamId.mockResolvedValue(null);
    mocks.getRole.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects a signed-out visitor to the login page", async () => {
    mocks.getServerSession.mockResolvedValue(null);

    await expect(renderPage()).rejects.toThrow("REDIRECT:/auth/login");
  });

  it("returns 404 for a non-numeric id, an unknown team and an organization row", async () => {
    await expect(renderPage("abc")).rejects.toThrow("NOT_FOUND");

    mocks.findBasicById.mockResolvedValueOnce(null);
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");

    mocks.findBasicById.mockResolvedValueOnce({ id: 3, parentId: null, isOrganization: true });
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
  });

  it("looks the team and membership up through the repositories", async () => {
    mocks.findRoleAndAcceptedByUserIdAndTeamId.mockResolvedValue({
      role: MembershipRole.ADMIN,
      accepted: true,
    });

    const element = await renderPage();

    expect(mocks.findBasicById).toHaveBeenCalledWith({ teamId: 3 });
    expect(mocks.findRoleAndAcceptedByUserIdAndTeamId).toHaveBeenCalledWith({ userId: 7, teamId: 3 });
    expect(element.props).toEqual({ teamId: 3, viewerId: 7, canManage: true, isPendingInvite: false });
  });

  it("shows a pending invitee the page without management rights", async () => {
    mocks.findRoleAndAcceptedByUserIdAndTeamId.mockResolvedValue({
      role: MembershipRole.ADMIN,
      accepted: false,
    });

    const element = await renderPage();

    expect(element.props).toMatchObject({ canManage: false, isPendingInvite: true });
  });

  it("returns 404 to a non-member while organizations are off, even an org admin", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    mocks.getRole.mockResolvedValue("OWNER");

    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(mocks.getRole).not.toHaveBeenCalled();
  });

  it("lets an admin of the parent organization manage the team when organizations are on", async () => {
    vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    mocks.getRole.mockResolvedValue("ADMIN");

    const element = await renderPage();

    expect(mocks.getRole).toHaveBeenCalledWith(7, 1);
    expect(element.props).toMatchObject({ canManage: true, isPendingInvite: false });
  });
});
