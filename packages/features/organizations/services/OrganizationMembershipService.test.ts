import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryOrganizationMembershipRepository } from "../tests/InMemoryOrganizationMembershipRepository";
import { InMemoryOrganizationRepository } from "../tests/InMemoryOrganizationRepository";
import {
  OrganizationMembershipService,
  USERNAME_TAKEN_IN_ORGANIZATION,
} from "./OrganizationMembershipService";

const { mockLogInfo } = vi.hoisted(() => ({ mockLogInfo: vi.fn() }));

vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: () => ({ info: mockLogInfo, debug: vi.fn() }) },
}));

const ORG_ID = 10;
const OTHER_ORG_ID = 20;
const DEFAULT_ORG_ID = 30;
const DEFAULT_DOMAIN = "cal.example.com";

const FORBIDDEN_CHANGE = "Only organization owners and admins can change roles";
type Invitee = {
  id: number;
  email: string;
  name: string | null;
  locale: string | null;
  organizationId: number | null;
  username: string | null;
  hasPassword: boolean;
};

function buildUserRepository() {
  return {
    findInviteeByEmail: vi.fn<(p: { email: string }) => Promise<Invitee | null>>().mockResolvedValue(null),
    createInvitedWithPendingTeamMembership: vi.fn().mockResolvedValue({
      id: 77,
      email: "new@acme.com",
      locale: "pl",
    }),
    setOrganizationId: vi.fn().mockResolvedValue(undefined),
  };
}

const FORBIDDEN_OWNER = "Only owners can grant or remove the owner role";

async function expectRejection(promise: Promise<unknown>, code: ErrorCode, message: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ErrorWithCode);
  if (!(error instanceof ErrorWithCode)) return;
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
}

describe("OrganizationMembershipService", () => {
  let organizationRepository: InMemoryOrganizationRepository;
  let membershipRepository: InMemoryOrganizationMembershipRepository;
  let service: OrganizationMembershipService;
  let userRepository: ReturnType<typeof buildUserRepository>;
  let sendInvite: Mock;
  let disableByFrom: Mock;
  let moveUser: Mock;

  beforeEach(() => {
    userRepository = buildUserRepository();
    sendInvite = vi.fn().mockResolvedValue(undefined);
    disableByFrom = vi.fn().mockResolvedValue(0);
    moveUser = vi.fn().mockResolvedValue({ userId: 3, organizationId: DEFAULT_ORG_ID, username: "user3" });
    organizationRepository = new InMemoryOrganizationRepository();
    membershipRepository = new InMemoryOrganizationMembershipRepository();
    organizationRepository.seed({ id: ORG_ID, name: "Acme", slug: "acme", domain: "acme.com" });
    organizationRepository.seed({ id: OTHER_ORG_ID, name: "Globex", slug: "globex", domain: "globex.com" });
    organizationRepository.seed({ id: DEFAULT_ORG_ID, name: "Cal", slug: "cal", domain: DEFAULT_DOMAIN });
    mockLogInfo.mockClear();
    service = new OrganizationMembershipService({
      organizationMembershipRepository: membershipRepository,
      organizationRepository,
      organizationsConfig: { defaultDomain: DEFAULT_DOMAIN },
      userRepository,
      teamInviteService: { sendInvite },
      tempOrgRedirectRepository: { disableByFrom },
      organizationMoveService: { moveUser },
    });
  });

  describe("addMember", () => {
    it("sets the user's organization and creates the profile and accepted membership", async () => {
      membershipRepository.seedUser({ id: 1, username: "alice" });

      const result = await service.addMember({ organizationId: ORG_ID, userId: 1, role: "ADMIN" });

      expect(result).toEqual({ userId: 1, organizationId: ORG_ID, role: "ADMIN" });
      expect(membershipRepository.users.find((user) => user.id === 1)?.organizationId).toBe(ORG_ID);
      expect(membershipRepository.profiles).toEqual([
        { userId: 1, organizationId: ORG_ID, username: "alice" },
      ]);
      expect(membershipRepository.memberships).toEqual([
        { userId: 1, teamId: ORG_ID, role: "ADMIN", accepted: true },
      ]);
      expect(disableByFrom).toHaveBeenCalledWith({ fromOrgId: ORG_ID, from: "alice", types: ["User"] });
    });

    it("rejects a user who belongs to another organization", async () => {
      membershipRepository.seedUser({ id: 1, username: "alice", organizationId: OTHER_ORG_ID });

      await expectRejection(
        service.addMember({ organizationId: ORG_ID, userId: 1, role: "MEMBER" }),
        ErrorCode.Conflict,
        "User belongs to another organization"
      );
    });

    it("rejects a user without a username", async () => {
      membershipRepository.seedUser({ id: 1, username: null });

      await expectRejection(
        service.addMember({ organizationId: ORG_ID, userId: 1, role: "MEMBER" }),
        ErrorCode.PreconditionFailed,
        "User needs a username before joining an organization"
      );
    });

    it("rejects a username already taken in the organization", async () => {
      membershipRepository.seedUser({ id: 1, username: "alice" });
      membershipRepository.seedProfile({ userId: 2, organizationId: ORG_ID, username: "alice" });

      await expectRejection(
        service.addMember({ organizationId: ORG_ID, userId: 1, role: "MEMBER" }),
        ErrorCode.Conflict,
        "Username is already taken in this organization"
      );
      expect(disableByFrom).not.toHaveBeenCalled();
    });

    it("uses the given username for a user without one", async () => {
      membershipRepository.seedUser({ id: 1, username: null });
      const addMember = vi.spyOn(membershipRepository, "addMember");

      await service.addMember({ organizationId: ORG_ID, userId: 1, role: "MEMBER", username: "alice" });

      expect(addMember).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        userId: 1,
        username: "alice",
        role: "MEMBER",
      });
      expect(disableByFrom).toHaveBeenCalledWith({ fromOrgId: ORG_ID, from: "alice", types: ["User"] });
    });

    it("checks the given username, not the stored one, for conflicts", async () => {
      membershipRepository.seedUser({ id: 1, username: "alice" });
      membershipRepository.seedProfile({ userId: 2, organizationId: ORG_ID, username: "taken" });
      const isUsernameTaken = vi.spyOn(membershipRepository, "isUsernameTaken");

      await expectRejection(
        service.addMember({ organizationId: ORG_ID, userId: 1, role: "MEMBER", username: "taken" }),
        ErrorCode.Conflict,
        USERNAME_TAKEN_IN_ORGANIZATION
      );
      expect(isUsernameTaken).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        username: "taken",
        excludeUserId: 1,
      });
      expect(disableByFrom).not.toHaveBeenCalled();
    });

    it("rejects a missing organization", async () => {
      membershipRepository.seedUser({ id: 1, username: "alice" });

      await expectRejection(
        service.addMember({ organizationId: 999, userId: 1, role: "MEMBER" }),
        ErrorCode.NotFound,
        "Organization not found"
      );
    });

    it("rejects a missing user", async () => {
      await expectRejection(
        service.addMember({ organizationId: ORG_ID, userId: 999, role: "MEMBER" }),
        ErrorCode.NotFound,
        "User not found"
      );
    });

    it("keeps the existing role when re-adding a member", async () => {
      membershipRepository.seedUser({ id: 1, username: "alice", organizationId: ORG_ID });
      membershipRepository.seedProfile({ userId: 1, organizationId: ORG_ID, username: "alice" });
      membershipRepository.seedMembership({ userId: 1, teamId: ORG_ID, role: "OWNER", accepted: false });

      const result = await service.addMember({ organizationId: ORG_ID, userId: 1, role: "MEMBER" });

      expect(result.role).toBe("OWNER");
      expect(membershipRepository.memberships).toEqual([
        { userId: 1, teamId: ORG_ID, role: "OWNER", accepted: true },
      ]);
      expect(membershipRepository.profiles).toHaveLength(1);
    });
  });

  describe("setRole", () => {
    const OWNER_ID = 1;
    const ADMIN_ID = 2;
    const MEMBER_ID = 3;

    beforeEach(() => {
      const seeded: [number, OrganizationRoleDto][] = [
        [OWNER_ID, "OWNER"],
        [ADMIN_ID, "ADMIN"],
        [MEMBER_ID, "MEMBER"],
      ];
      for (const [userId, role] of seeded) {
        membershipRepository.seedUser({ id: userId, organizationId: ORG_ID });
        membershipRepository.seedMembership({ userId, teamId: ORG_ID, role });
      }
    });

    function setRole(actorUserId: number, userId: number, role: OrganizationRoleDto) {
      return service.setRole({ organizationId: ORG_ID, actorUserId, userId, role });
    }

    it("lets an admin grant ADMIN and MEMBER", async () => {
      await expect(setRole(ADMIN_ID, MEMBER_ID, "ADMIN")).resolves.toEqual({
        userId: MEMBER_ID,
        role: "ADMIN",
      });
      await expect(setRole(ADMIN_ID, MEMBER_ID, "MEMBER")).resolves.toEqual({
        userId: MEMBER_ID,
        role: "MEMBER",
      });
      expect(await service.getRole(MEMBER_ID, ORG_ID)).toBe("MEMBER");
    });

    it("forbids an admin from granting OWNER", async () => {
      await expectRejection(setRole(ADMIN_ID, MEMBER_ID, "OWNER"), ErrorCode.Forbidden, FORBIDDEN_OWNER);
    });

    it("forbids an admin from demoting an owner", async () => {
      await expectRejection(setRole(ADMIN_ID, OWNER_ID, "ADMIN"), ErrorCode.Forbidden, FORBIDDEN_OWNER);
    });

    it("lets an owner grant OWNER", async () => {
      await expect(setRole(OWNER_ID, ADMIN_ID, "OWNER")).resolves.toEqual({
        userId: ADMIN_ID,
        role: "OWNER",
      });
      expect(await membershipRepository.countOwners(ORG_ID)).toBe(2);
    });

    it("refuses to demote the last owner", async () => {
      await expectRejection(
        setRole(OWNER_ID, OWNER_ID, "ADMIN"),
        ErrorCode.PreconditionFailed,
        "An organization must keep at least one owner"
      );
      expect(await service.getRole(OWNER_ID, ORG_ID)).toBe("OWNER");
    });

    it("lets a second owner be demoted", async () => {
      membershipRepository.seedMembership({ userId: ADMIN_ID, teamId: ORG_ID, role: "OWNER" });

      await expect(setRole(OWNER_ID, ADMIN_ID, "MEMBER")).resolves.toEqual({
        userId: ADMIN_ID,
        role: "MEMBER",
      });
    });

    it("forbids a MEMBER actor", async () => {
      await expectRejection(setRole(MEMBER_ID, ADMIN_ID, "MEMBER"), ErrorCode.Forbidden, FORBIDDEN_CHANGE);
    });

    it("forbids an actor who is not a member", async () => {
      await expectRejection(setRole(999, MEMBER_ID, "ADMIN"), ErrorCode.Forbidden, FORBIDDEN_CHANGE);
    });

    it("rejects a missing target member", async () => {
      await expectRejection(setRole(OWNER_ID, 999, "ADMIN"), ErrorCode.NotFound, "Member not found");
    });

    it("logs the role change with ids only", async () => {
      await setRole(OWNER_ID, MEMBER_ID, "ADMIN");

      expect(mockLogInfo).toHaveBeenCalledWith("organization.member.role", {
        action: "organization.member.role",
        actorUserId: OWNER_ID,
        organizationId: ORG_ID,
        userId: MEMBER_ID,
        role: "ADMIN",
      });
    });

    it("returns without writing when the role is unchanged", async () => {
      await expect(setRole(OWNER_ID, ADMIN_ID, "ADMIN")).resolves.toEqual({
        userId: ADMIN_ID,
        role: "ADMIN",
      });
      expect(membershipRepository.updateRoleCalls).toBe(0);
    });
  });

  describe("getRole", () => {
    it("returns the member's role or null", async () => {
      membershipRepository.seedMembership({ userId: 1, teamId: ORG_ID, role: "ADMIN" });

      expect(await service.getRole(1, ORG_ID)).toBe("ADMIN");
      expect(await service.getRole(2, ORG_ID)).toBeNull();
    });
  });

  describe("listMembers", () => {
    const ACTOR_ID = 1;

    function seedMember(params: {
      id: number;
      name?: string | null;
      username?: string | null;
      email?: string;
      role?: OrganizationRoleDto;
      accepted?: boolean;
      organizationId?: number;
    }) {
      const organizationId = params.organizationId ?? ORG_ID;
      membershipRepository.seedUser({
        id: params.id,
        name: params.name,
        username: params.username,
        email: params.email,
        organizationId,
      });
      membershipRepository.seedMembership({
        userId: params.id,
        teamId: organizationId,
        role: params.role ?? "MEMBER",
        accepted: params.accepted,
      });
    }

    beforeEach(() => {
      seedMember({ id: ACTOR_ID, name: "Alice", username: "alice", email: "alice@acme.com", role: "OWNER" });
    });

    it("lets any accepted member list members, including pending invitees", async () => {
      seedMember({
        id: 2,
        name: null,
        username: null,
        email: "bob@acme.com",
        role: "ADMIN",
        accepted: false,
      });
      seedMember({ id: 3, organizationId: OTHER_ORG_ID });

      const result = await service.listMembers({ organizationId: ORG_ID, actorUserId: ACTOR_ID });

      expect(result).toEqual({
        items: [
          {
            userId: ACTOR_ID,
            name: "Alice",
            email: "alice@acme.com",
            username: "alice",
            role: "OWNER",
            accepted: true,
          },
          { userId: 2, name: null, email: "bob@acme.com", username: null, role: "ADMIN", accepted: false },
        ],
        nextCursor: undefined,
      });
    });

    it("allows a plain member to list members", async () => {
      seedMember({ id: 2, role: "MEMBER" });

      const result = await service.listMembers({ organizationId: ORG_ID, actorUserId: 2 });

      expect(result.items.map((item) => item.userId)).toEqual([ACTOR_ID, 2]);
    });

    it("searches name, email and username case-insensitively", async () => {
      seedMember({ id: 2, name: "Bobby Tables", username: "bt", email: "b@acme.com" });
      seedMember({ id: 3, name: "Carol", username: "ROBERTA", email: "c@acme.com" });
      seedMember({ id: 4, name: "Dave", username: "dave", email: "BOB@globex.com" });
      seedMember({ id: 5, name: "Eve", username: "eve", email: "eve@acme.com" });

      const byName = await service.listMembers({
        organizationId: ORG_ID,
        actorUserId: ACTOR_ID,
        search: "BOB",
      });
      const byUsername = await service.listMembers({
        organizationId: ORG_ID,
        actorUserId: ACTOR_ID,
        search: "robert",
      });

      expect(byName.items.map((item) => item.userId)).toEqual([2, 4]);
      expect(byUsername.items.map((item) => item.userId)).toEqual([3]);
    });

    it("pages through members with a cursor", async () => {
      seedMember({ id: 2 });
      seedMember({ id: 3 });

      const first = await service.listMembers({ organizationId: ORG_ID, actorUserId: ACTOR_ID, limit: 2 });
      expect(first.items.map((item) => item.userId)).toEqual([ACTOR_ID, 2]);
      expect(first.nextCursor).toBeDefined();

      const second = await service.listMembers({
        organizationId: ORG_ID,
        actorUserId: ACTOR_ID,
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.items.map((item) => item.userId)).toEqual([3]);
      expect(second.nextCursor).toBeUndefined();
    });

    it("clamps the limit to between 1 and 100, defaulting to 50", async () => {
      const listMembers = vi.spyOn(membershipRepository, "listMembers");

      await service.listMembers({ organizationId: ORG_ID, actorUserId: ACTOR_ID });
      await service.listMembers({ organizationId: ORG_ID, actorUserId: ACTOR_ID, limit: 500 });
      await service.listMembers({ organizationId: ORG_ID, actorUserId: ACTOR_ID, limit: 0 });

      expect(listMembers.mock.calls.map(([params]) => params.limit)).toEqual([50, 100, 1]);
    });

    it("hides the organization from non-members", async () => {
      seedMember({ id: 2, organizationId: OTHER_ORG_ID });

      await expectRejection(
        service.listMembers({ organizationId: ORG_ID, actorUserId: 2 }),
        ErrorCode.NotFound,
        "Organization not found"
      );
    });

    it("hides the organization from pending invitees", async () => {
      seedMember({ id: 2, role: "ADMIN", accepted: false });

      await expectRejection(
        service.listMembers({ organizationId: ORG_ID, actorUserId: 2 }),
        ErrorCode.NotFound,
        "Organization not found"
      );
    });
  });

  describe("listTeams", () => {
    function seedActor(id: number, role: OrganizationRoleDto, accepted = true) {
      membershipRepository.seedUser({ id, organizationId: ORG_ID });
      membershipRepository.seedMembership({ userId: id, teamId: ORG_ID, role, accepted });
    }

    beforeEach(() => {
      membershipRepository.seedTeam({ id: ORG_ID, parentId: null, isOrganization: true });
      membershipRepository.seedTeam({ id: 101, parentId: ORG_ID, name: "Engineering", slug: "eng" });
      membershipRepository.seedTeam({ id: 102, parentId: ORG_ID, name: "Sales", slug: "sales" });
      membershipRepository.seedTeam({ id: 201, parentId: OTHER_ORG_ID });
      membershipRepository.seedMembership({ userId: 50, teamId: 101, role: "MEMBER" });
      membershipRepository.seedMembership({ userId: 51, teamId: 101, role: "MEMBER", accepted: false });
    });

    it.each<OrganizationRoleDto>([
      "OWNER",
      "ADMIN",
    ])("shows a %s every sub-team, including ones they are not in", async (role) => {
      seedActor(1, role);
      membershipRepository.seedMembership({ userId: 1, teamId: 102, role: "MEMBER" });
      const listTeams = vi.spyOn(membershipRepository, "listTeams");

      const result = await service.listTeams({ organizationId: ORG_ID, actorUserId: 1 });

      expect(listTeams.mock.calls[0][0].memberUserId).toBeUndefined();
      expect(result).toEqual({
        items: [
          { teamId: 101, name: "Engineering", slug: "eng", memberCount: 1, viewerIsMember: false },
          { teamId: 102, name: "Sales", slug: "sales", memberCount: 1, viewerIsMember: true },
        ],
        nextCursor: undefined,
      });
    });

    it("shows a plain member only the teams they belong to", async () => {
      seedActor(2, "MEMBER");
      membershipRepository.seedMembership({ userId: 2, teamId: 102, role: "MEMBER" });
      const listTeams = vi.spyOn(membershipRepository, "listTeams");

      const result = await service.listTeams({ organizationId: ORG_ID, actorUserId: 2, search: "SAL" });

      expect(listTeams).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        viewerUserId: 2,
        memberUserId: 2,
        search: "SAL",
        cursor: undefined,
        limit: 50,
      });
      expect(result.items.map((item) => item.teamId)).toEqual([102]);
    });

    it("hides the organization from non-members and pending invitees", async () => {
      seedActor(3, "ADMIN", false);

      for (const actorUserId of [3, 4]) {
        await expectRejection(
          service.listTeams({ organizationId: ORG_ID, actorUserId }),
          ErrorCode.NotFound,
          "Organization not found"
        );
      }
    });
  });

  describe("findMembershipCandidate", () => {
    it("returns the seeded user", async () => {
      membershipRepository.seedUser({
        id: 1,
        username: "alice",
        email: "alice@acme.com",
        organizationId: ORG_ID,
      });

      expect(await service.findMembershipCandidate(1)).toEqual({
        id: 1,
        username: "alice",
        email: "alice@acme.com",
        organizationId: ORG_ID,
      });
    });

    it("returns null for an unknown user", async () => {
      expect(await service.findMembershipCandidate(999)).toBeNull();
    });
  });

  describe("removeMember", () => {
    const OWNER_ID = 1;
    const ADMIN_ID = 2;
    const MEMBER_ID = 3;

    beforeEach(() => {
      const seeded: [number, OrganizationRoleDto][] = [
        [OWNER_ID, "OWNER"],
        [ADMIN_ID, "ADMIN"],
        [MEMBER_ID, "MEMBER"],
      ];
      for (const [userId, role] of seeded) {
        membershipRepository.seedUser({ id: userId, organizationId: ORG_ID });
        membershipRepository.seedMembership({ userId, teamId: ORG_ID, role });
        membershipRepository.seedProfile({ userId, organizationId: ORG_ID, username: `user${userId}` });
      }
    });

    function removeMember(
      actorUserId: number,
      userId: number,
      organizationId = ORG_ID,
      newUsername?: string
    ) {
      return service.removeMember({ organizationId, actorUserId, userId, newUsername });
    }

    it("moves the member to the default organization", async () => {
      await expect(removeMember(ADMIN_ID, MEMBER_ID)).resolves.toEqual({ userId: MEMBER_ID });

      expect(moveUser).toHaveBeenCalledWith(
        { userId: MEMBER_ID, toOrganizationId: DEFAULT_ORG_ID, newUsername: undefined },
        ADMIN_ID,
        { allowMissingUsername: true }
      );
      expect(mockLogInfo).toHaveBeenCalledWith("organization.member.remove", {
        action: "organization.member.remove",
        actorUserId: ADMIN_ID,
        organizationId: ORG_ID,
        userId: MEMBER_ID,
        toOrganizationId: DEFAULT_ORG_ID,
      });
    });

    it("passes a new username through to the move", async () => {
      await removeMember(ADMIN_ID, MEMBER_ID, ORG_ID, "fresh-name");

      expect(moveUser).toHaveBeenCalledWith(
        { userId: MEMBER_ID, toOrganizationId: DEFAULT_ORG_ID, newUsername: "fresh-name" },
        ADMIN_ID,
        { allowMissingUsername: true }
      );
    });

    it("reports a username taken in the default organization", async () => {
      moveUser.mockRejectedValue(ErrorWithCode.Factory.Conflict("username_taken_in_target_organization"));

      await expectRejection(
        removeMember(ADMIN_ID, MEMBER_ID),
        ErrorCode.Conflict,
        "username_taken_in_default_organization"
      );
      expect(mockLogInfo).not.toHaveBeenCalledWith("organization.member.remove", expect.anything());
    });

    it.each([
      [ErrorCode.BadRequest, "invalid_username"],
      [ErrorCode.Conflict, "move_conflict"],
    ])("rethrows other move errors unchanged (%s %s)", async (code, message) => {
      const error = new ErrorWithCode(code, message);
      moveUser.mockRejectedValue(error);

      await expect(removeMember(ADMIN_ID, MEMBER_ID)).rejects.toBe(error);
    });

    it("forbids a MEMBER actor", async () => {
      await expectRejection(
        removeMember(MEMBER_ID, ADMIN_ID),
        ErrorCode.Forbidden,
        "Only organization owners and admins can manage members"
      );
      expect(moveUser).not.toHaveBeenCalled();
    });

    it("forbids an admin from removing an owner", async () => {
      await expectRejection(
        removeMember(ADMIN_ID, OWNER_ID),
        ErrorCode.Forbidden,
        "Only owners can remove an owner"
      );
      expect(moveUser).not.toHaveBeenCalled();
    });

    it("refuses to remove the last owner", async () => {
      await expectRejection(
        removeMember(OWNER_ID, OWNER_ID),
        ErrorCode.PreconditionFailed,
        "An organization must keep at least one owner"
      );
      expect(moveUser).not.toHaveBeenCalled();
    });

    it("lets a pending owner invite be withdrawn", async () => {
      membershipRepository.seedUser({ id: 4, username: null, organizationId: ORG_ID });
      membershipRepository.seedMembership({ userId: 4, teamId: ORG_ID, role: "OWNER", accepted: false });

      await expect(removeMember(OWNER_ID, 4)).resolves.toEqual({ userId: 4 });
      expect(moveUser).toHaveBeenCalledWith(
        { userId: 4, toOrganizationId: DEFAULT_ORG_ID, newUsername: undefined },
        OWNER_ID,
        { allowMissingUsername: true }
      );
    });

    it.each([
      ["no organization", null],
      ["another organization", OTHER_ORG_ID],
    ])("refuses a member whose user belongs to %s", async (_label, organizationId) => {
      membershipRepository.seedUser({ id: MEMBER_ID, organizationId });

      await expectRejection(
        removeMember(ADMIN_ID, MEMBER_ID),
        ErrorCode.PreconditionFailed,
        "member_not_in_organization"
      );
      expect(moveUser).not.toHaveBeenCalled();
    });

    it("refuses removal from the default organization", async () => {
      membershipRepository.seedMembership({ userId: ADMIN_ID, teamId: DEFAULT_ORG_ID, role: "ADMIN" });

      await expectRejection(
        removeMember(ADMIN_ID, MEMBER_ID, DEFAULT_ORG_ID),
        ErrorCode.PreconditionFailed,
        "Members cannot be removed from the default organization"
      );
      expect(moveUser).not.toHaveBeenCalled();
    });

    it("refuses removal when the default organization is missing", async () => {
      service = new OrganizationMembershipService({
        organizationMembershipRepository: membershipRepository,
        organizationRepository,
        organizationsConfig: { defaultDomain: null },
        userRepository,
        teamInviteService: { sendInvite },
        tempOrgRedirectRepository: { disableByFrom },
        organizationMoveService: { moveUser },
      });

      await expectRejection(
        removeMember(ADMIN_ID, MEMBER_ID),
        ErrorCode.PreconditionFailed,
        "Default organization not found"
      );
      expect(moveUser).not.toHaveBeenCalled();
    });

    it("rejects an unknown member", async () => {
      await expectRejection(removeMember(ADMIN_ID, 999), ErrorCode.NotFound, "Member not found");
      expect(moveUser).not.toHaveBeenCalled();
    });
  });

  describe("inviteMember", () => {
    const OWNER_ID = 1;
    const ADMIN_ID = 2;
    const MEMBER_ID = 3;

    beforeEach(() => {
      membershipRepository.seedMembership({ userId: OWNER_ID, teamId: ORG_ID, role: "OWNER" });
      membershipRepository.seedMembership({ userId: ADMIN_ID, teamId: ORG_ID, role: "ADMIN" });
      membershipRepository.seedMembership({ userId: MEMBER_ID, teamId: ORG_ID, role: "MEMBER" });
    });

    function invite(actorUserId: number, role: OrganizationRoleDto = "MEMBER", email = " New@Acme.com ") {
      return service.inviteMember({ organizationId: ORG_ID, actorUserId, actorName: "Ada", email, role });
    }

    function seedInvitee(overrides: Partial<Invitee> = {}): Invitee {
      const invitee: Invitee = {
        id: 5,
        email: "new@acme.com",
        name: "Bob",
        locale: "de",
        organizationId: null,
        username: "bob",
        hasPassword: true,
        ...overrides,
      };
      membershipRepository.seedUser(invitee);
      userRepository.findInviteeByEmail.mockResolvedValue(invitee);
      return invitee;
    }

    function expectInviteSent(locale: string, isExistingUser: boolean) {
      expect(sendInvite).toHaveBeenCalledWith({
        teamId: ORG_ID,
        teamName: "Acme",
        email: "new@acme.com",
        inviterName: "Ada",
        locale,
        isExistingUser,
        isOrganization: true,
      });
    }

    it("creates a pending user for an unknown email and sends the org invite", async () => {
      await expect(invite(ADMIN_ID, "ADMIN")).resolves.toEqual({ invited: true });

      expect(userRepository.findInviteeByEmail).toHaveBeenCalledWith({ email: "new@acme.com" });
      expect(userRepository.createInvitedWithPendingTeamMembership).toHaveBeenCalledWith({
        email: "new@acme.com",
        teamId: ORG_ID,
        role: "ADMIN",
        organizationId: ORG_ID,
      });
      expectInviteSent("pl", false);
      expect(mockLogInfo).toHaveBeenCalledWith("organization.member.invite", {
        action: "organization.member.invite",
        actorUserId: ADMIN_ID,
        organizationId: ORG_ID,
        targetUserId: 77,
        role: "ADMIN",
      });
      expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain("acme.com");
    });

    it("rejects plain members", async () => {
      await expectRejection(
        invite(MEMBER_ID),
        ErrorCode.Forbidden,
        "Only organization owners and admins can manage members"
      );
    });

    it("forbids an admin from inviting an owner", async () => {
      await expectRejection(invite(ADMIN_ID, "OWNER"), ErrorCode.Forbidden, FORBIDDEN_OWNER);
      expect(sendInvite).not.toHaveBeenCalled();
    });

    it("lets an owner invite an owner", async () => {
      await expect(invite(OWNER_ID, "OWNER")).resolves.toEqual({ invited: true });
    });

    it("rejects a missing organization", async () => {
      vi.spyOn(organizationRepository, "findById").mockResolvedValue(null);

      await expectRejection(invite(ADMIN_ID), ErrorCode.NotFound, "Organization not found");
    });

    it.each(["   ", "not-an-email"])("rejects the invalid email %j", async (email) => {
      await expectRejection(invite(ADMIN_ID, "MEMBER", email), ErrorCode.BadRequest, "Invalid invite email");
      expect(userRepository.findInviteeByEmail).not.toHaveBeenCalled();
    });

    it("rejects a user from another organization", async () => {
      seedInvitee({ organizationId: OTHER_ORG_ID });

      await expectRejection(invite(ADMIN_ID), ErrorCode.Conflict, "user_belongs_to_another_organization");
      expect(sendInvite).not.toHaveBeenCalled();
    });

    it("rejects an existing member", async () => {
      seedInvitee({ organizationId: ORG_ID });
      membershipRepository.seedMembership({ userId: 5, teamId: ORG_ID, role: "MEMBER" });

      await expectRejection(invite(ADMIN_ID), ErrorCode.Conflict, "user_is_already_a_member");
    });

    it("resends the invite for a pending membership without changing it", async () => {
      seedInvitee({ hasPassword: false, locale: null });
      membershipRepository.seedMembership({ userId: 5, teamId: ORG_ID, role: "ADMIN", accepted: false });
      const createPendingMembership = vi.spyOn(membershipRepository, "createPendingMembership");

      await invite(ADMIN_ID);

      expect(createPendingMembership).not.toHaveBeenCalled();
      expect(await membershipRepository.findMembership({ organizationId: ORG_ID, userId: 5 })).toEqual({
        role: "ADMIN",
        accepted: false,
      });
      expectInviteSent("en", false);
    });

    it("adds a user with a username straight away and notifies them", async () => {
      seedInvitee();

      await invite(ADMIN_ID, "ADMIN");

      expect(await service.getRole(5, ORG_ID)).toBe("ADMIN");
      expect(membershipRepository.profiles).toContainEqual({
        userId: 5,
        organizationId: ORG_ID,
        username: "bob",
      });
      expectInviteSent("de", true);
    });

    it("creates a pending membership and attaches a username-less user to the org", async () => {
      seedInvitee({ username: null });

      await invite(ADMIN_ID);

      expect(await membershipRepository.findMembership({ organizationId: ORG_ID, userId: 5 })).toEqual({
        role: "MEMBER",
        accepted: false,
      });
      expect(userRepository.setOrganizationId).toHaveBeenCalledWith({ id: 5, organizationId: ORG_ID });
      expectInviteSent("de", true);
    });

    it("does not repoint a username-less user already in the org", async () => {
      seedInvitee({ username: null, organizationId: ORG_ID });

      await invite(ADMIN_ID);

      expect(userRepository.setOrganizationId).not.toHaveBeenCalled();
    });
  });

  describe("inviteOwner", () => {
    it("invites an unknown email as OWNER without any actor membership", async () => {
      await expect(
        service.inviteOwner({
          organizationId: ORG_ID,
          email: " New@Acme.com ",
          inviterName: "Instance Admin",
        })
      ).resolves.toEqual({ invited: true });

      expect(userRepository.createInvitedWithPendingTeamMembership).toHaveBeenCalledWith({
        email: "new@acme.com",
        teamId: ORG_ID,
        role: "OWNER",
        organizationId: ORG_ID,
      });
      expect(sendInvite).toHaveBeenCalledWith({
        teamId: ORG_ID,
        teamName: "Acme",
        email: "new@acme.com",
        inviterName: "Instance Admin",
        locale: "pl",
        isExistingUser: false,
        isOrganization: true,
      });
      expect(mockLogInfo).toHaveBeenCalledWith("organization.member.invite", {
        action: "organization.member.invite",
        actorUserId: null,
        organizationId: ORG_ID,
        targetUserId: 77,
        role: "OWNER",
      });
    });
  });

  describe("grantOwner", () => {
    const USER_ID = 5;

    function grant() {
      return service.grantOwner({ organizationId: ORG_ID, userId: USER_ID });
    }

    it("promotes an accepted member to OWNER", async () => {
      membershipRepository.seedUser({ id: USER_ID, username: "bob", organizationId: ORG_ID });
      membershipRepository.seedMembership({ userId: USER_ID, teamId: ORG_ID, role: "MEMBER" });

      await expect(grant()).resolves.toEqual({ userId: USER_ID, role: "OWNER" });

      expect(await service.getRole(USER_ID, ORG_ID)).toBe("OWNER");
      expect(membershipRepository.updateRoleCalls).toBe(1);
      expect(mockLogInfo).toHaveBeenCalledWith("organization.owner.grant", {
        action: "organization.owner.grant",
        organizationId: ORG_ID,
        userId: USER_ID,
      });
    });

    it("leaves an existing owner untouched", async () => {
      membershipRepository.seedMembership({ userId: USER_ID, teamId: ORG_ID, role: "OWNER" });

      await expect(grant()).resolves.toEqual({ userId: USER_ID, role: "OWNER" });

      expect(membershipRepository.updateRoleCalls).toBe(0);
    });

    it("keeps the other owners' roles", async () => {
      membershipRepository.seedMembership({ userId: 1, teamId: ORG_ID, role: "OWNER" });
      membershipRepository.seedMembership({ userId: USER_ID, teamId: ORG_ID, role: "ADMIN" });

      await grant();

      expect(await membershipRepository.countOwners(ORG_ID)).toBe(2);
    });

    it("adds an outsider with a username as OWNER", async () => {
      membershipRepository.seedUser({ id: USER_ID, username: "bob" });

      await expect(grant()).resolves.toEqual({ userId: USER_ID, role: "OWNER" });

      expect(membershipRepository.memberships).toEqual([
        { userId: USER_ID, teamId: ORG_ID, role: "OWNER", accepted: true },
      ]);
      expect(membershipRepository.profiles).toEqual([
        { userId: USER_ID, organizationId: ORG_ID, username: "bob" },
      ]);
      expect(membershipRepository.updateRoleCalls).toBe(0);
    });

    it("accepts a pending MEMBER invite and raises it to OWNER", async () => {
      membershipRepository.seedUser({ id: USER_ID, username: "bob", organizationId: ORG_ID });
      membershipRepository.seedMembership({
        userId: USER_ID,
        teamId: ORG_ID,
        role: "MEMBER",
        accepted: false,
      });

      await expect(grant()).resolves.toEqual({ userId: USER_ID, role: "OWNER" });

      expect(await membershipRepository.findMembership({ organizationId: ORG_ID, userId: USER_ID })).toEqual({
        role: "OWNER",
        accepted: true,
      });
      expect(membershipRepository.updateRoleCalls).toBe(1);
    });

    it("rejects a user without a username", async () => {
      membershipRepository.seedUser({ id: USER_ID, username: null });

      await expectRejection(
        grant(),
        ErrorCode.PreconditionFailed,
        "The owner needs a username before joining an organization"
      );
      expect(membershipRepository.memberships).toEqual([]);
    });

    it("rejects a user from another organization", async () => {
      membershipRepository.seedUser({ id: USER_ID, username: "bob", organizationId: OTHER_ORG_ID });

      await expectRejection(grant(), ErrorCode.PreconditionFailed, "owner_in_another_organization");
      expect(membershipRepository.memberships).toEqual([]);
    });

    it("rejects a missing user", async () => {
      await expectRejection(grant(), ErrorCode.NotFound, "Owner user not found");
    });
  });

  describe("findMembershipCandidateByEmail", () => {
    it("trims and lowercases the email before the lookup", async () => {
      const findUserByEmail = vi.spyOn(membershipRepository, "findUserByEmail");
      membershipRepository.seedUser({ id: 1, username: "alice", email: "alice@acme.com" });

      expect(await service.findMembershipCandidateByEmail("  Alice@ACME.com ")).toEqual({
        id: 1,
        username: "alice",
        email: "alice@acme.com",
        organizationId: null,
      });
      expect(findUserByEmail).toHaveBeenCalledWith("alice@acme.com");
    });

    it("returns null for an unknown email", async () => {
      expect(await service.findMembershipCandidateByEmail("nobody@acme.com")).toBeNull();
    });
  });
});
