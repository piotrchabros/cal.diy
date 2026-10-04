import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

import { MembershipRole } from "@calcom/prisma/enums";

import { TeamMembersService } from "@calcom/features/membership/services/TeamMembersService";

import { acceptInviteHandler } from "./acceptInvite.handler";
import { getHandler } from "./get.handler";
import { inviteMemberHandler } from "./inviteMember.handler";
import { listMembersHandler } from "./listMembers.handler";
import { myTeamsHandler } from "./myTeams.handler";
import { removeMemberHandler } from "./removeMember.handler";
import { resendInviteHandler } from "./resendInvite.handler";
import { updateRoleHandler } from "./updateRole.handler";

vi.mock("@calcom/features/membership/services/TeamMembersService", () => ({
  TeamMembersService: vi.fn(),
}));

const mockCtx = {
  user: {
    id: 9,
    name: "Piotr Chabros",
    email: "piotr@example.com",
  },
} as never;

describe("viewer.teams mutation handlers", () => {
  const serviceMock = {
    getTeam: vi.fn(),
    listMembers: vi.fn(),
    listMyTeams: vi.fn(),
    inviteMember: vi.fn(),
    acceptInvite: vi.fn(),
    updateMemberRole: vi.fn(),
    removeMember: vi.fn(),
    resendInvite: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (TeamMembersService as unknown as Mock).mockImplementation(function () {
      return serviceMock;
    } as never);
  });

  it("inviteMember forwards team, requester and input", async () => {
    serviceMock.inviteMember.mockResolvedValue({ status: "invited", email: "ada@example.com" });

    const result = await inviteMemberHandler({
      ctx: mockCtx,
      input: { teamId: 7, email: "ada@example.com", role: MembershipRole.MEMBER },
    });

    expect(result).toEqual({ status: "invited", email: "ada@example.com" });
    expect(serviceMock.inviteMember).toHaveBeenCalledWith({
      teamId: 7,
      requesterId: 9,
      requesterName: "Piotr Chabros",
      email: "ada@example.com",
      role: MembershipRole.MEMBER,
    });
  });

  it("acceptInvite accepts for the session user only", async () => {
    serviceMock.acceptInvite.mockResolvedValue({ status: "accepted" });

    await acceptInviteHandler({ ctx: mockCtx, input: { teamId: 7 } });

    expect(serviceMock.acceptInvite).toHaveBeenCalledWith({ teamId: 7, userId: 9 });
  });

  it("updateRole forwards role change", async () => {
    serviceMock.updateMemberRole.mockResolvedValue({ id: 6, role: "ADMIN", accepted: true });

    await updateRoleHandler({
      ctx: mockCtx,
      input: { teamId: 7, userId: 12, role: MembershipRole.ADMIN },
    });

    expect(serviceMock.updateMemberRole).toHaveBeenCalledWith({
      teamId: 7,
      requesterId: 9,
      userId: 12,
      role: MembershipRole.ADMIN,
    });
  });

  it("removeMember forwards removal", async () => {
    serviceMock.removeMember.mockResolvedValue({ id: 6 });

    await removeMemberHandler({ ctx: mockCtx, input: { teamId: 7, userId: 12 } });

    expect(serviceMock.removeMember).toHaveBeenCalledWith({ teamId: 7, requesterId: 9, userId: 12 });
  });

  it("resendInvite forwards email", async () => {
    serviceMock.resendInvite.mockResolvedValue({ status: "resent", email: "ada@example.com" });

    await resendInviteHandler({ ctx: mockCtx, input: { teamId: 7, email: "ada@example.com" } });

    expect(serviceMock.resendInvite).toHaveBeenCalledWith({
      teamId: 7,
      requesterId: 9,
      requesterName: "Piotr Chabros",
      email: "ada@example.com",
    });
  });

  it("myTeams lists the session user's teams", async () => {
    serviceMock.listMyTeams.mockResolvedValue([{ id: 7, name: "BlueBee" }]);

    const result = await myTeamsHandler({ ctx: mockCtx });

    expect(result).toEqual([{ id: 7, name: "BlueBee" }]);
    expect(serviceMock.listMyTeams).toHaveBeenCalledWith({ userId: 9 });
  });

  it("getTeam forwards team and viewer", async () => {
    serviceMock.getTeam.mockResolvedValue({ id: 7, name: "BlueBee" });

    const result = await getHandler({ ctx: mockCtx, input: { teamId: 7 } });

    expect(result).toEqual({ id: 7, name: "BlueBee" });
    expect(serviceMock.getTeam).toHaveBeenCalledWith({ teamId: 7, viewerId: 9 });
  });

  it("listMembers forwards viewer and filters", async () => {
    serviceMock.listMembers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });

    await listMembersHandler({
      ctx: mockCtx,
      input: { teamId: 7, search: "ada", accepted: false, page: 1, pageSize: 10 },
    });

    expect(serviceMock.listMembers).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 7, viewerId: 9, search: "ada", accepted: false })
    );
  });
});
