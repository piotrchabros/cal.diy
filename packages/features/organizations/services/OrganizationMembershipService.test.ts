import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryOrganizationMembershipRepository } from "../tests/InMemoryOrganizationMembershipRepository";
import { InMemoryOrganizationRepository } from "../tests/InMemoryOrganizationRepository";
import { OrganizationMembershipService } from "./OrganizationMembershipService";

const ORG_ID = 10;
const OTHER_ORG_ID = 20;

const FORBIDDEN_CHANGE = "Only organization owners and admins can change roles";
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

  beforeEach(() => {
    organizationRepository = new InMemoryOrganizationRepository();
    membershipRepository = new InMemoryOrganizationMembershipRepository();
    organizationRepository.seed({ id: ORG_ID, name: "Acme", slug: "acme", domain: "acme.com" });
    organizationRepository.seed({ id: OTHER_ORG_ID, name: "Globex", slug: "globex", domain: "globex.com" });
    service = new OrganizationMembershipService({
      organizationMembershipRepository: membershipRepository,
      organizationRepository,
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
});
