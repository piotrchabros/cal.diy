import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IOrganizationMoveRepository,
  MoveTeamRecord,
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
const TEAM_ID = 5;
const OTHER_ORG_ID = 30;

const member = (userId: number, username: string | null, organizationId: number, accepted = true) => ({
  userId,
  name: username,
  email: `${username ?? userId}@example.com`,
  username,
  organizationId,
  accepted,
});

// alice is in the source org, bob is in a third org, carol is a pending invitee and dave is already in the target
const TEAM_MEMBERS = [
  member(USER_ID, "alice", FROM_ORG_ID),
  member(2, "bob", OTHER_ORG_ID),
  member(3, "carol", OTHER_ORG_ID, false),
  member(4, "dave", TO_ORG_ID),
];

const BASE_URLS: Record<number, string> = {
  [FROM_ORG_ID]: "https://acme.example.com",
  [TO_ORG_ID]: "https://globex.example.com",
  [OTHER_ORG_ID]: "https://initech.example.com",
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

  const seedTeam = (team: Partial<MoveTeamRecord> = {}) => {
    moveRepository.findTeamForMove.mockResolvedValue({
      id: TEAM_ID,
      slug: "sales",
      parentId: FROM_ORG_ID,
      isOrganization: false,
      members: TEAM_MEMBERS,
      ...team,
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
      isTeamSlugTaken: vi.fn<IOrganizationMoveRepository["isTeamSlugTaken"]>().mockResolvedValue(false),
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

    describe("with allowMissingUsername", () => {
      it("moves a user without a username, skipping the conflict check and redirect", async () => {
        seedUser({ username: null });

        const result = await service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID }, ACTOR_ID, {
          allowMissingUsername: true,
        });

        expect(result).toEqual({ userId: USER_ID, organizationId: TO_ORG_ID, username: null });
        expect(moveRepository.findTakenUsernames).not.toHaveBeenCalled();
        expect(getBaseUrl).not.toHaveBeenCalled();
        const move = moveRepository.applyMove.mock.calls[0][0].users[0];
        expect(move.username).toBeNull();
        expect(move.redirect).toBeNull();
      });

      it("still rejects a user without a username when the option is not given", async () => {
        seedUser({ username: null });

        await expectRejection(
          service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID }, ACTOR_ID, {}),
          ErrorCode.PreconditionFailed,
          MOVE_ERRORS.usernameRequired
        );
        expect(moveRepository.applyMove).not.toHaveBeenCalled();
      });

      it("uses a given new username and points the redirect at it", async () => {
        seedUser();

        const result = await service.moveUser(
          { userId: USER_ID, toOrganizationId: TO_ORG_ID, newUsername: "alice-2" },
          ACTOR_ID,
          { allowMissingUsername: true }
        );

        expect(result.username).toBe("alice-2");
        expect(moveRepository.findTakenUsernames).toHaveBeenCalledWith({
          organizationId: TO_ORG_ID,
          usernames: ["alice-2"],
          excludeUserIds: [USER_ID],
        });
        const move = moveRepository.applyMove.mock.calls[0][0].users[0];
        expect(move.username).toBe("alice-2");
        expect(move.redirect).toEqual({
          fromOrgId: FROM_ORG_ID,
          from: "alice",
          toUrl: "https://globex.example.com/alice-2",
        });
      });

      // T181: removing a member moves them to the default org, so their old org URL must keep resolving
      it("writes a redirect from the old org base URL to the target org base URL", async () => {
        seedUser();

        await service.moveUser({ userId: USER_ID, toOrganizationId: TO_ORG_ID }, ACTOR_ID, {
          allowMissingUsername: true,
        });

        expect(moveRepository.applyMove.mock.calls[0][0].users[0].redirect).toEqual({
          fromOrgId: FROM_ORG_ID,
          from: "alice",
          toUrl: `${BASE_URLS[TO_ORG_ID]}/alice`,
        });
        expect(getBaseUrl).toHaveBeenCalledWith({ organizationId: FROM_ORG_ID });
        expect(getBaseUrl).toHaveBeenCalledWith({ organizationId: TO_ORG_ID });
      });
    });
  });

  it.each([
    { case: "a missing team", team: null, to: TO_ORG_ID, message: "Team not found" },
    { case: "an organization", team: { isOrganization: true }, to: TO_ORG_ID, message: "Team not found" },
    { case: "a standalone team", team: { parentId: null }, to: TO_ORG_ID, message: "Team not found" },
    { case: "a missing target organization", team: {}, to: 999, message: "Organization not found" },
  ])("previewMoveTeam and moveTeam reject $case", async ({ team, to, message }) => {
    if (team) seedTeam(team);
    else moveRepository.findTeamForMove.mockResolvedValue(null);

    await expectRejection(
      service.previewMoveTeam({ teamId: TEAM_ID, toOrganizationId: to }),
      ErrorCode.NotFound,
      message
    );
    await expectRejection(
      service.moveTeam({ teamId: TEAM_ID, toOrganizationId: to, outsideMembers: "move" }, ACTOR_ID),
      ErrorCode.NotFound,
      message
    );
  });

  describe("previewMoveTeam", () => {
    it("lists accepted members outside the target with username and slug conflicts", async () => {
      seedTeam({ members: [...TEAM_MEMBERS, member(6, null, OTHER_ORG_ID)] });
      moveRepository.findTakenUsernames.mockResolvedValue(["bob"]);
      moveRepository.isTeamSlugTaken.mockResolvedValue(true);

      const preview = await service.previewMoveTeam({ teamId: TEAM_ID, toOrganizationId: TO_ORG_ID });

      expect(preview).toEqual({
        membersOutsideTarget: [
          {
            userId: USER_ID,
            name: "alice",
            email: "alice@example.com",
            usernameTaken: false,
            usernameMissing: false,
          },
          { userId: 2, name: "bob", email: "bob@example.com", usernameTaken: true, usernameMissing: false },
          { userId: 6, name: null, email: "6@example.com", usernameTaken: false, usernameMissing: true },
        ],
        slugTaken: true,
      });
      expect(moveRepository.findTakenUsernames).toHaveBeenCalledWith({
        organizationId: TO_ORG_ID,
        usernames: ["alice", "bob"],
        excludeUserIds: [USER_ID, 2, 6],
      });
    });

    it("does not check the slug of a team without one", async () => {
      seedTeam({ slug: null });

      const preview = await service.previewMoveTeam({ teamId: TEAM_ID, toOrganizationId: TO_ORG_ID });

      expect(preview.slugTaken).toBe(false);
      expect(moveRepository.isTeamSlugTaken).not.toHaveBeenCalled();
    });
  });

  describe("moveTeam", () => {
    it("moves accepted outside members, removes pending ones and writes team and user redirects", async () => {
      seedTeam();

      const result = await service.moveTeam(
        { teamId: TEAM_ID, toOrganizationId: TO_ORG_ID, outsideMembers: "move" },
        ACTOR_ID
      );

      expect(result).toEqual({ teamId: TEAM_ID, organizationId: TO_ORG_ID, slug: "sales" });
      expect(moveRepository.findTakenUsernames).toHaveBeenCalledWith({
        organizationId: TO_ORG_ID,
        usernames: ["alice", "bob"],
        excludeUserIds: [USER_ID, 2],
      });
      const userMove = { toOrganizationId: TO_ORG_ID, role: "MEMBER", keepTeamIds: [TEAM_ID] };
      expect(moveRepository.applyMove).toHaveBeenCalledWith({
        team: {
          teamId: TEAM_ID,
          toOrganizationId: TO_ORG_ID,
          slug: "sales",
          removeMembers: [{ userId: 3, email: "carol@example.com" }],
          redirect: { fromOrgId: FROM_ORG_ID, from: "sales", toUrl: "https://globex.example.com/team/sales" },
        },
        users: [
          {
            ...userMove,
            userId: USER_ID,
            email: "alice@example.com",
            fromOrganizationId: FROM_ORG_ID,
            username: "alice",
            redirect: { fromOrgId: FROM_ORG_ID, from: "alice", toUrl: "https://globex.example.com/alice" },
          },
          {
            ...userMove,
            userId: 2,
            email: "bob@example.com",
            fromOrganizationId: OTHER_ORG_ID,
            username: "bob",
            redirect: { fromOrgId: OTHER_ORG_ID, from: "bob", toUrl: "https://globex.example.com/bob" },
          },
        ],
      });
      expect(mockLogInfo).toHaveBeenCalledWith("organization.team.move", {
        action: "organization.team.move",
        actorUserId: ACTOR_ID,
        targetTeamId: TEAM_ID,
        fromOrganizationId: FROM_ORG_ID,
        organizationId: TO_ORG_ID,
        movedUserIds: [USER_ID, 2],
        removedUserIds: [3],
      });
    });

    it("removes every outside member when asked to, skipping the owner check", async () => {
      seedTeam({ members: [member(USER_ID, null, FROM_ORG_ID), member(3, "carol", null, false)] });
      membershipRepository.seedMembership({ userId: USER_ID, teamId: FROM_ORG_ID, role: "OWNER" });

      await service.moveTeam(
        { teamId: TEAM_ID, toOrganizationId: TO_ORG_ID, outsideMembers: "remove" },
        ACTOR_ID
      );

      const move = moveRepository.applyMove.mock.calls[0][0];
      expect(move.users).toEqual([]);
      expect(move.team?.removeMembers).toEqual([
        { userId: USER_ID, email: `${USER_ID}@example.com` },
        { userId: 3, email: "carol@example.com" },
      ]);
    });

    it("uses a valid new slug, normalised to lower case, in the team redirect", async () => {
      seedTeam();

      const result = await service.moveTeam(
        { teamId: TEAM_ID, toOrganizationId: TO_ORG_ID, newSlug: " Sales-EU ", outsideMembers: "remove" },
        ACTOR_ID
      );

      expect(result.slug).toBe("sales-eu");
      expect(moveRepository.isTeamSlugTaken.mock.calls[0][0]).toMatchObject({
        slug: "sales-eu",
        excludeTeamId: TEAM_ID,
      });
      expect(moveRepository.applyMove.mock.calls[0][0].team?.redirect).toEqual({
        fromOrgId: FROM_ORG_ID,
        from: "sales",
        toUrl: "https://globex.example.com/team/sales-eu",
      });
    });

    it.each([
      { case: "a team without a slug", slug: null, baseUrl: undefined },
      { case: "a shared base URL and unchanged slug", slug: "sales", baseUrl: "https://cal.example.com" },
    ])("writes no team redirect for $case", async ({ slug, baseUrl }) => {
      seedTeam({ slug });
      if (baseUrl) getBaseUrl.mockResolvedValue(baseUrl);

      await service.moveTeam(
        { teamId: TEAM_ID, toOrganizationId: TO_ORG_ID, outsideMembers: "remove" },
        ACTOR_ID
      );

      const team = moveRepository.applyMove.mock.calls[0][0].team;
      expect(team?.slug).toBe(slug);
      expect(team?.redirect).toBeNull();
      expect(moveRepository.isTeamSlugTaken).toHaveBeenCalledTimes(slug === null ? 0 : 1);
    });

    describe("with newUsernames", () => {
      const moveWith = (
        newUsernames: { userId: number; username: string }[],
        outsideMembers: "move" | "remove" = "move"
      ) =>
        service.moveTeam(
          { teamId: TEAM_ID, toOrganizationId: TO_ORG_ID, outsideMembers, newUsernames },
          ACTOR_ID
        );

      it("moves a mover whose username is taken under the new one, redirecting old to new", async () => {
        seedTeam();
        moveRepository.findTakenUsernames.mockImplementation(async ({ usernames }) =>
          usernames.filter((u) => u === "alice")
        );

        await moveWith([{ userId: USER_ID, username: "alice2" }]);

        expect(moveRepository.findTakenUsernames).toHaveBeenCalledWith({
          organizationId: TO_ORG_ID,
          usernames: ["alice2", "bob"],
          excludeUserIds: [USER_ID, 2],
        });
        const alice = moveRepository.applyMove.mock.calls[0][0].users.find((u) => u.userId === USER_ID);
        expect(alice?.username).toBe("alice2");
        expect(alice?.redirect).toEqual({
          fromOrgId: FROM_ORG_ID,
          from: "alice",
          toUrl: "https://globex.example.com/alice2",
        });
      });

      it("normalises a new username to lower case", async () => {
        seedTeam();

        await moveWith([{ userId: USER_ID, username: " Alice-EU " }]);

        const alice = moveRepository.applyMove.mock.calls[0][0].users.find((u) => u.userId === USER_ID);
        expect(alice?.username).toBe("alice-eu");
      });

      it("lets a mover without a username move under the new one, without a redirect", async () => {
        seedTeam({ members: [member(USER_ID, null, FROM_ORG_ID)] });

        await moveWith([{ userId: USER_ID, username: "alice" }]);

        expect(moveRepository.applyMove.mock.calls[0][0].users).toEqual([
          expect.objectContaining({ userId: USER_ID, username: "alice", redirect: null }),
        ]);
      });

      it("moves a member flagged as missing a username in the preview under the given one", async () => {
        seedTeam({ members: [member(6, null, null)] });

        await moveWith([{ userId: 6, username: "eve" }]);

        expect(moveRepository.applyMove.mock.calls[0][0].users).toEqual([
          expect.objectContaining({ userId: 6, fromOrganizationId: null, username: "eve" }),
        ]);
      });

      it("ignores new usernames when outside members are removed", async () => {
        seedTeam();

        await moveWith([{ userId: USER_ID, username: "alice2" }], "remove");

        const move = moveRepository.applyMove.mock.calls[0][0];
        expect(move.users).toEqual([]);
        expect(move.team?.removeMembers.map((m) => m.userId)).toEqual([USER_ID, 2, 3]);
        expect(moveRepository.findTakenUsernames).toHaveBeenCalledWith(
          expect.objectContaining({ usernames: [] })
        );
      });

      it.each([
        {
          case: "an invalid new username",
          newUsernames: [{ userId: USER_ID, username: "alice smith" }],
          code: ErrorCode.BadRequest,
          message: MOVE_ERRORS.invalidUsername,
        },
        {
          case: "a new username that is still taken",
          newUsernames: [{ userId: USER_ID, username: "alice2" }],
          taken: ["alice2"],
          code: ErrorCode.Conflict,
          message: MOVE_ERRORS.memberUsernamesTaken,
        },
        {
          case: "two movers ending with the same username",
          newUsernames: [{ userId: USER_ID, username: "bob" }],
          code: ErrorCode.Conflict,
          message: MOVE_ERRORS.memberUsernamesTaken,
        },
      ])("rejects $case without applying anything", async (c) => {
        seedTeam();
        if (c.taken) moveRepository.findTakenUsernames.mockResolvedValue(c.taken);

        await expectRejection(moveWith(c.newUsernames), c.code, c.message);
        expect(moveRepository.applyMove).not.toHaveBeenCalled();
      });
    });

    it.each([
      {
        case: "a team already in the target",
        team: { parentId: TO_ORG_ID },
        code: ErrorCode.BadRequest,
        message: MOVE_ERRORS.teamAlreadyInOrganization,
      },
      {
        case: "an invalid new slug",
        newSlug: "sales team",
        code: ErrorCode.BadRequest,
        message: MOVE_ERRORS.invalidSlug,
      },
      { case: "a taken slug", slugTaken: true, code: ErrorCode.Conflict, message: MOVE_ERRORS.slugTaken },
      {
        case: "a mover without a username",
        team: { members: [member(2, null, OTHER_ORG_ID)] },
        code: ErrorCode.PreconditionFailed,
        message: MOVE_ERRORS.usernameRequired,
      },
      {
        case: "duplicate mover usernames",
        team: { members: [member(2, "bob", OTHER_ORG_ID), member(6, "bob", OTHER_ORG_ID)] },
        code: ErrorCode.Conflict,
        message: MOVE_ERRORS.memberUsernamesTaken,
      },
      {
        case: "a taken mover username",
        taken: ["bob"],
        code: ErrorCode.Conflict,
        message: MOVE_ERRORS.memberUsernamesTaken,
      },
      {
        case: "moving the last owner",
        lastOwner: true,
        code: ErrorCode.PreconditionFailed,
        message: MOVE_ERRORS.lastOwner,
      },
    ])("rejects $case without applying anything", async (c) => {
      seedTeam(c.team);
      if (c.slugTaken) moveRepository.isTeamSlugTaken.mockResolvedValue(true);
      if (c.taken) moveRepository.findTakenUsernames.mockResolvedValue(c.taken);
      if (c.lastOwner)
        membershipRepository.seedMembership({ userId: USER_ID, teamId: FROM_ORG_ID, role: "OWNER" });

      const input = {
        teamId: TEAM_ID,
        toOrganizationId: TO_ORG_ID,
        newSlug: c.newSlug,
        outsideMembers: "move" as const,
      };
      await expectRejection(service.moveTeam(input, ACTOR_ID), c.code, c.message);
      expect(moveRepository.applyMove).not.toHaveBeenCalled();
    });
  });

  describe("listTeams", () => {
    it("lists every team of the organization without requiring membership, clamping the limit", async () => {
      membershipRepository.seedTeam({ id: 6, parentId: TO_ORG_ID, name: "Sales" });
      membershipRepository.seedTeam({ id: 7, parentId: TO_ORG_ID, name: "Support" });
      membershipRepository.seedTeam({ id: 8, parentId: FROM_ORG_ID, name: "Elsewhere" });
      const listTeams = vi.spyOn(membershipRepository, "listTeams");

      const page = await service.listTeams({ organizationId: TO_ORG_ID, actorUserId: ACTOR_ID, limit: 0 });

      expect(page).toEqual({
        items: [{ teamId: 6, name: "Sales", slug: "team-6", memberCount: 0, viewerIsMember: false }],
        nextCursor: 6,
      });
      expect(listTeams.mock.calls[0][0]).toMatchObject({ viewerUserId: ACTOR_ID, memberUserId: undefined });

      await service.listTeams({ organizationId: TO_ORG_ID, actorUserId: ACTOR_ID, search: "sup", cursor: 6 });
      await service.listTeams({ organizationId: TO_ORG_ID, actorUserId: ACTOR_ID, limit: 500 });
      expect(listTeams.mock.calls.map(([params]) => params.limit)).toEqual([1, 50, 100]);
    });

    it("rejects a missing organization", async () => {
      await expectRejection(
        service.listTeams({ organizationId: 999, actorUserId: ACTOR_ID }),
        ErrorCode.NotFound,
        "Organization not found"
      );
    });
  });
});
