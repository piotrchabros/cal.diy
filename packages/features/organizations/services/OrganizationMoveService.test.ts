import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IOrganizationMoveRepository,
  MoveUserRecord,
} from "../repositories/interfaces/IOrganizationMoveRepository";
import { InMemoryOrganizationMembershipRepository } from "../tests/InMemoryOrganizationMembershipRepository";
import { InMemoryOrganizationRepository } from "../tests/InMemoryOrganizationRepository";
import { MOVE_ERRORS, OrganizationMoveService } from "./OrganizationMoveService";
import type { OrganizationUrlService } from "./OrganizationUrlService";

const { mockLogInfo } = vi.hoisted(() => ({ mockLogInfo: vi.fn() }));

vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: () => ({ info: mockLogInfo }) },
}));

const FROM_ORG_ID = 10;
const TO_ORG_ID = 20;
const USER_ID = 1;
const ACTOR_ID = 100;

const BASE_URLS: Record<number, string> = {
  [FROM_ORG_ID]: "https://acme.example.com",
  [TO_ORG_ID]: "https://globex.example.com",
};

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

describe("OrganizationMoveService", () => {
  let organizationRepository: InMemoryOrganizationRepository;
  let membershipRepository: InMemoryOrganizationMembershipRepository;
  let moveRepository: {
    [K in keyof IOrganizationMoveRepository]: ReturnType<typeof vi.fn<IOrganizationMoveRepository[K]>>;
  };
  let getBaseUrl: ReturnType<typeof vi.fn<OrganizationUrlService["getBaseUrl"]>>;
  let service: OrganizationMoveService;

  const seedUser = (user: Partial<MoveUserRecord> = {}) => {
    moveRepository.findUserForMove.mockResolvedValue({
      id: USER_ID,
      username: "alice",
      email: "alice@example.com",
      organizationId: FROM_ORG_ID,
      ...user,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    organizationRepository = new InMemoryOrganizationRepository();
    membershipRepository = new InMemoryOrganizationMembershipRepository();
    organizationRepository.seed({ id: FROM_ORG_ID, name: "Acme", slug: "acme", memberCount: 2 });
    organizationRepository.seed({ id: TO_ORG_ID, name: "Globex", slug: "globex" });
    moveRepository = {
      findUserForMove: vi.fn<IOrganizationMoveRepository["findUserForMove"]>(),
      findTeamForMove: vi.fn<IOrganizationMoveRepository["findTeamForMove"]>(),
      isTeamSlugTaken: vi.fn<IOrganizationMoveRepository["isTeamSlugTaken"]>(),
      findTakenUsernames: vi.fn<IOrganizationMoveRepository["findTakenUsernames"]>().mockResolvedValue([]),
      applyMove: vi.fn<IOrganizationMoveRepository["applyMove"]>().mockResolvedValue(undefined),
    };
    getBaseUrl = vi
      .fn<OrganizationUrlService["getBaseUrl"]>()
      .mockImplementation(async ({ organizationId }) => BASE_URLS[organizationId ?? 0]);
    service = new OrganizationMoveService({
      organizationMoveRepository: moveRepository,
      organizationMembershipRepository: membershipRepository,
      organizationRepository,
      organizationUrlService: { getBaseUrl },
    });
  });

  describe("moveUser", () => {
    it("moves the user with a MEMBER role and a redirect, logging only ids", async () => {
      seedUser();

      const result = await service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID }, ACTOR_ID);

      expect(result).toEqual({ userId: USER_ID, organizationId: TO_ORG_ID, username: "alice" });
      expect(moveRepository.findTakenUsernames).toHaveBeenCalledWith({
        organizationId: TO_ORG_ID,
        usernames: ["alice"],
        excludeUserIds: [USER_ID],
      });
      expect(moveRepository.applyMove).toHaveBeenCalledWith({
        users: [
          {
            userId: USER_ID,
            email: "alice@example.com",
            fromOrganizationId: FROM_ORG_ID,
            toOrganizationId: TO_ORG_ID,
            username: "alice",
            role: "MEMBER",
            keepTeamIds: [],
            redirect: { fromOrgId: FROM_ORG_ID, from: "alice", toUrl: "https://globex.example.com/alice" },
          },
        ],
      });
      expect(mockLogInfo).toHaveBeenCalledWith("organization.member.move", {
        action: "organization.member.move",
        actorUserId: ACTOR_ID,
        targetUserId: USER_ID,
        fromOrganizationId: FROM_ORG_ID,
        organizationId: TO_ORG_ID,
      });
    });

    it("passes an OWNER role through to the move", async () => {
      seedUser();

      await service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID, role: "OWNER" }, ACTOR_ID);

      expect(moveRepository.applyMove.mock.calls[0][0].users[0].role).toBe("OWNER");
    });

    it("uses a valid new username, normalised to lower case, after a conflict", async () => {
      seedUser();
      moveRepository.findTakenUsernames.mockResolvedValueOnce(["alice"]);
      await expectRejection(
        service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID }, ACTOR_ID),
        ErrorCode.Conflict,
        MOVE_ERRORS.usernameTaken
      );

      const result = await service.moveUser(
        { userId: USER_ID, toOrganizationId: TO_ORG_ID, newUsername: " Alice-2 " },
        ACTOR_ID
      );

      expect(result.username).toBe("alice-2");
      const move = moveRepository.applyMove.mock.calls[0][0].users[0];
      expect(move.username).toBe("alice-2");
      expect(move.redirect).toEqual({
        fromOrgId: FROM_ORG_ID,
        from: "alice",
        toUrl: "https://globex.example.com/alice-2",
      });
    });

    it.each([
      "",
      "   ",
      "alice smith",
      "alice!",
      "-alice",
    ])("rejects the invalid new username %j", async (newUsername) => {
      seedUser();

      await expectRejection(
        service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID, newUsername }, ACTOR_ID),
        ErrorCode.BadRequest,
        MOVE_ERRORS.invalidUsername
      );
      expect(moveRepository.applyMove).not.toHaveBeenCalled();
    });

    it.each([
      {
        case: "a missing user",
        user: null,
        to: TO_ORG_ID,
        code: ErrorCode.NotFound,
        message: "User not found",
      },
      {
        case: "a missing target organization",
        user: {},
        to: 999,
        code: ErrorCode.NotFound,
        message: "Organization not found",
      },
      {
        case: "a user already in the target organization",
        user: { organizationId: TO_ORG_ID },
        to: TO_ORG_ID,
        code: ErrorCode.BadRequest,
        message: MOVE_ERRORS.userAlreadyInOrganization,
      },
      {
        case: "a user without a username when no new one is given",
        user: { username: null },
        to: TO_ORG_ID,
        code: ErrorCode.PreconditionFailed,
        message: MOVE_ERRORS.usernameRequired,
      },
    ])("rejects $case", async ({ user, to, code, message }) => {
      if (user) seedUser(user);
      else moveRepository.findUserForMove.mockResolvedValue(null);

      await expectRejection(
        service.moveUser({ userId: USER_ID, toOrganizationId: to }, ACTOR_ID),
        code,
        message
      );
    });

    it("moves a user without a username when a new one is given, without a redirect", async () => {
      seedUser({ username: null });

      await service.moveUser(
        { userId: USER_ID, toOrganizationId: TO_ORG_ID, newUsername: "alice" },
        ACTOR_ID
      );

      expect(moveRepository.applyMove.mock.calls[0][0].users[0].redirect).toBeNull();
      expect(getBaseUrl).not.toHaveBeenCalled();
    });

    it("refuses to move the last owner out of an org with other members", async () => {
      seedUser();
      membershipRepository.seedMembership({ userId: USER_ID, teamId: FROM_ORG_ID, role: "OWNER" });

      await expectRejection(
        service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID }, ACTOR_ID),
        ErrorCode.PreconditionFailed,
        MOVE_ERRORS.lastOwner
      );
      expect(moveRepository.applyMove).not.toHaveBeenCalled();
    });

    it.each([
      { case: "another owner remains", otherOwner: true, memberCount: 2 },
      { case: "they are the only member", otherOwner: false, memberCount: 1 },
    ])("moves an owner when $case", async ({ otherOwner, memberCount }) => {
      organizationRepository.seed({ id: FROM_ORG_ID, name: "Acme", slug: "acme", memberCount });
      seedUser();
      membershipRepository.seedMembership({ userId: USER_ID, teamId: FROM_ORG_ID, role: "OWNER" });
      if (otherOwner) membershipRepository.seedMembership({ userId: 2, teamId: FROM_ORG_ID, role: "OWNER" });

      await service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID }, ACTOR_ID);

      expect(moveRepository.applyMove).toHaveBeenCalledTimes(1);
    });

    it("moves a user without an organization without an owner check or redirect", async () => {
      seedUser({ organizationId: null });
      const findRole = vi.spyOn(membershipRepository, "findRole");

      await service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID }, ACTOR_ID);

      expect(findRole).not.toHaveBeenCalled();
      const move = moveRepository.applyMove.mock.calls[0][0].users[0];
      expect(move.fromOrganizationId).toBeNull();
      expect(move.redirect).toBeNull();
    });

    it.each([
      { newUsername: undefined, redirect: null },
      {
        newUsername: "alice2",
        redirect: { fromOrgId: FROM_ORG_ID, from: "alice", toUrl: "https://cal.example.com/alice2" },
      },
    ])("on a shared base URL writes $redirect for new username $newUsername", async ({
      newUsername,
      redirect,
    }) => {
      seedUser();
      getBaseUrl.mockResolvedValue("https://cal.example.com");

      await service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID, newUsername }, ACTOR_ID);

      expect(moveRepository.applyMove.mock.calls[0][0].users[0].redirect).toEqual(redirect);
    });
  });
});
