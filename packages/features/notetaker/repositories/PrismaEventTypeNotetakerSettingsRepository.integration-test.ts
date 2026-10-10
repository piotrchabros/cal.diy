import { prisma } from "@calcom/prisma";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isQuickstartIsolatedDatabase, QUICKSTART_SKIP_MESSAGE } from "../tests/quickstartHarness";
import { PrismaEventTypeNotetakerSettingsRepository } from "./PrismaEventTypeNotetakerSettingsRepository";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PREFIX = `notetaker-settings-it-${runId}`;

// The default DATABASE_URL of this checkout is a live site's database, so the file runs only
// against the scratch database.
const RUNS_ON_ISOLATED_DATABASE: boolean = isQuickstartIsolatedDatabase();

const SUITE = "PrismaEventTypeNotetakerSettingsRepository (integration)";

const SET_AT = new Date("2030-04-01T09:00:00.000Z");
const LATER_SET_AT = new Date("2030-04-02T09:00:00.000Z");
// Ids are autoincrement and positive, so -1 never matches a real user.
const UNKNOWN_USER_ID = -1;

const repository = new PrismaEventTypeNotetakerSettingsRepository(prisma);

type Fixtures = {
  actor: { id: number; name: string };
  secondActor: { id: number; name: string };
  memberA: { id: number; name: string };
  memberB: { id: number; name: string };
  memberC: { id: number; name: string };
  organization: { id: number; name: string };
  subTeam: { id: number; name: string };
  standaloneTeam: { id: number; name: string };
  otherTeam: { id: number; name: string };
  subTeamEventType: { id: number; title: string };
  standaloneEventTypeA: { id: number; title: string };
  standaloneEventTypeB: { id: number; title: string };
  hostsOnlyEventType: { id: number; title: string };
  selectedEventType: { id: number; title: string };
  otherTeamEventType: { id: number; title: string };
  personalEventType: { id: number; title: string };
};

let fixtures: Fixtures | undefined;
const userIds: number[] = [];
const teamIds: number[] = [];
const eventTypeIds: number[] = [];

function fx(): Fixtures {
  if (fixtures === undefined) {
    throw new Error("Test setup did not complete: fixtures are missing");
  }
  return fixtures;
}

async function createUser(label: string) {
  const name = `Settings IT ${label} ${runId}`;
  const user = await prisma.user.create({
    data: { email: `${PREFIX}-${label}@example.com`, username: `${PREFIX}-${label}`, name },
    select: { id: true },
  });
  userIds.push(user.id);
  return { id: user.id, name };
}

async function createTeam(label: string, options: { isOrganization?: boolean; parentId?: number } = {}) {
  const name = `Settings IT team ${label} ${runId}`;
  const team = await prisma.team.create({
    data: {
      name,
      slug: `${PREFIX}-${label}`,
      isOrganization: options.isOrganization ?? false,
      parentId: options.parentId ?? null,
    },
    select: { id: true },
  });
  teamIds.push(team.id);
  return { id: team.id, name };
}

async function createEventType(label: string, owner: { teamId: number } | { userId: number }) {
  const title = `Settings IT event ${label} ${runId}`;
  const eventType = await prisma.eventType.create({
    data: { title, slug: `${PREFIX}-${label}`, length: 30, ...owner },
    select: { id: true },
  });
  eventTypeIds.push(eventType.id);
  return { id: eventType.id, title };
}

function changeInput(overrides: Partial<Parameters<typeof repository.updateSharing>[0]["change"]> = {}) {
  return {
    actorUserId: fx().actor.id,
    actorName: fx().actor.name,
    previousMode: "HOSTS_ONLY" as const,
    newMode: "TEAM" as const,
    addedUserNames: [],
    removedUserNames: [],
    ...overrides,
  };
}

function readSettings(eventTypeId: number) {
  return prisma.eventTypeNotetakerSettings.findUnique({
    where: { eventTypeId },
    select: { enabledByDefault: true, sharingMode: true, sharingSetByUserId: true, sharingSetAt: true },
  });
}

function readMembers(eventTypeId: number) {
  return prisma.eventTypeNotetakerSharingMember.findMany({
    where: { eventTypeId },
    orderBy: { userId: "asc" },
    select: { userId: true, addedByUserId: true, addedAt: true },
  });
}

function readChanges(eventTypeId: number) {
  return prisma.eventTypeNotetakerSharingChange.findMany({
    where: { eventTypeId },
    select: {
      actorUserId: true,
      actorName: true,
      previousMode: true,
      newMode: true,
      addedUserNames: true,
      removedUserNames: true,
    },
  });
}

function countChanges(eventTypeId: number) {
  return prisma.eventTypeNotetakerSharingChange.count({ where: { eventTypeId } });
}

describe.runIf(!RUNS_ON_ISOLATED_DATABASE)(`${SUITE}: not run`, () => {
  it.skip(QUICKSTART_SKIP_MESSAGE, () => {});
});

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SUITE, () => {
  beforeAll(async () => {
    const actor = await createUser("actor");
    const secondActor = await createUser("second-actor");
    const memberA = await createUser("member-a");
    const memberB = await createUser("member-b");
    const memberC = await createUser("member-c");

    const organization = await createTeam("org", { isOrganization: true });
    const subTeam = await createTeam("sub", { parentId: organization.id });
    const standaloneTeam = await createTeam("standalone");
    const otherTeam = await createTeam("other");

    // Creation order matters: the list queries order by event type id.
    const subTeamEventType = await createEventType("sub", { teamId: subTeam.id });
    const standaloneEventTypeA = await createEventType("standalone-a", { teamId: standaloneTeam.id });
    const standaloneEventTypeB = await createEventType("standalone-b", { teamId: standaloneTeam.id });
    const hostsOnlyEventType = await createEventType("hosts-only", { teamId: standaloneTeam.id });
    const selectedEventType = await createEventType("selected", { teamId: standaloneTeam.id });
    const otherTeamEventType = await createEventType("other-team", { teamId: otherTeam.id });
    const personalEventType = await createEventType("personal", { userId: actor.id });

    fixtures = {
      actor,
      secondActor,
      memberA,
      memberB,
      memberC,
      organization,
      subTeam,
      standaloneTeam,
      otherTeam,
      subTeamEventType,
      standaloneEventTypeA,
      standaloneEventTypeB,
      hostsOnlyEventType,
      selectedEventType,
      otherTeamEventType,
      personalEventType,
    };
  });

  afterEach(async () => {
    // Prisma treats `where: { eventTypeId: undefined }` as no filter, so every delete needs an
    // explicit guard to avoid wiping a real database when setup failed before the ids were assigned.
    if (eventTypeIds.length > 0) {
      await prisma.eventTypeNotetakerSharingChange.deleteMany({
        where: { eventTypeId: { in: eventTypeIds } },
      });
      await prisma.eventTypeNotetakerSharingMember.deleteMany({
        where: { eventTypeId: { in: eventTypeIds } },
      });
      await prisma.eventTypeNotetakerSettings.deleteMany({ where: { eventTypeId: { in: eventTypeIds } } });
    }
  });

  afterAll(async () => {
    if (eventTypeIds.length > 0) {
      await prisma.eventType.deleteMany({ where: { id: { in: eventTypeIds } } });
    }
    eventTypeIds.length = 0;
    if (teamIds.length > 0) {
      await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
    }
    teamIds.length = 0;
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    userIds.length = 0;
    fixtures = undefined;
  });

  it("findByEventTypeId resolves null when there is no row", async () => {
    expect(await repository.findByEventTypeId(fx().standaloneEventTypeA.id)).toBeNull();
  });

  it("upsert creates a hosts-only row without a stamp and a second upsert changes only enabledByDefault", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;

    const created = await repository.upsert({ eventTypeId, enabledByDefault: false });
    expect(created).toMatchObject({
      eventTypeId,
      enabledByDefault: false,
      sharingMode: "HOSTS_ONLY",
      sharingSetByUserId: null,
      sharingSetAt: null,
    });

    const updated = await repository.upsert({ eventTypeId, enabledByDefault: true });
    expect(updated).toMatchObject({
      eventTypeId,
      enabledByDefault: true,
      sharingMode: "HOSTS_ONLY",
      sharingSetByUserId: null,
      sharingSetAt: null,
    });
  });

  it("upsert never writes the sharing columns", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;
    await repository.updateSharing({
      eventTypeId,
      sharingMode: "TEAM",
      sharingSetByUserId: fx().actor.id,
      sharingSetAt: SET_AT,
      change: changeInput(),
    });

    const result = await repository.upsert({ eventTypeId, enabledByDefault: true });

    expect(result.enabledByDefault).toBe(true);
    expect(result.sharingMode).toBe("TEAM");
    expect(result.sharingSetByUserId).toBe(fx().actor.id);
    expect(result.sharingSetAt).toEqual(SET_AT);
  });

  it("updateSharing creates the row for an event type without one and inserts one change row", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;

    await repository.updateSharing({
      eventTypeId,
      sharingMode: "TEAM",
      sharingSetByUserId: fx().actor.id,
      sharingSetAt: SET_AT,
      change: changeInput({
        previousMode: "HOSTS_ONLY",
        newMode: "TEAM",
        addedUserNames: ["Added One"],
        removedUserNames: ["Removed One", "Removed Two"],
      }),
    });

    expect(await readSettings(eventTypeId)).toEqual({
      enabledByDefault: false,
      sharingMode: "TEAM",
      sharingSetByUserId: fx().actor.id,
      sharingSetAt: SET_AT,
    });
    expect(await readChanges(eventTypeId)).toEqual([
      {
        actorUserId: fx().actor.id,
        actorName: fx().actor.name,
        previousMode: "HOSTS_ONLY",
        newMode: "TEAM",
        addedUserNames: ["Added One"],
        removedUserNames: ["Removed One", "Removed Two"],
      },
    ]);
    expect(await readMembers(eventTypeId)).toEqual([]);
  });

  it("updateSharing keeps enabledByDefault of an existing row", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;
    await repository.upsert({ eventTypeId, enabledByDefault: true });

    await repository.updateSharing({
      eventTypeId,
      sharingMode: "TEAM",
      sharingSetByUserId: fx().actor.id,
      sharingSetAt: SET_AT,
      change: changeInput(),
    });

    expect((await readSettings(eventTypeId))?.enabledByDefault).toBe(true);
  });

  it("SELECTED_PEOPLE creates a member row per id, stamped with the person who set it", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;
    const { memberA, memberB, actor } = fx();

    await repository.updateSharing({
      eventTypeId,
      sharingMode: "SELECTED_PEOPLE",
      sharingSetByUserId: actor.id,
      sharingSetAt: SET_AT,
      memberUserIds: [memberA.id, memberB.id],
      change: changeInput({ newMode: "SELECTED_PEOPLE" }),
    });

    const members = await readMembers(eventTypeId);
    expect(members.map((member) => member.userId)).toEqual([memberA.id, memberB.id]);
    expect(members.map((member) => member.addedByUserId)).toEqual([actor.id, actor.id]);
  });

  it("replacing the list removes dropped people, adds new ones and leaves kept rows untouched", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;
    const { memberA, memberB, memberC, actor, secondActor } = fx();
    const originalAddedAt = new Date("2030-03-15T08:00:00.000Z");

    await repository.updateSharing({
      eventTypeId,
      sharingMode: "SELECTED_PEOPLE",
      sharingSetByUserId: actor.id,
      sharingSetAt: SET_AT,
      memberUserIds: [memberA.id, memberB.id],
      change: changeInput({ newMode: "SELECTED_PEOPLE" }),
    });
    await prisma.eventTypeNotetakerSharingMember.update({
      where: { eventTypeId_userId: { eventTypeId, userId: memberB.id } },
      data: { addedAt: originalAddedAt },
      select: { userId: true },
    });

    await repository.updateSharing({
      eventTypeId,
      sharingMode: "SELECTED_PEOPLE",
      sharingSetByUserId: secondActor.id,
      sharingSetAt: LATER_SET_AT,
      memberUserIds: [memberB.id, memberC.id],
      change: changeInput({
        actorUserId: secondActor.id,
        previousMode: "SELECTED_PEOPLE",
        newMode: "SELECTED_PEOPLE",
      }),
    });

    const members = await readMembers(eventTypeId);
    expect(members.map((member) => member.userId)).toEqual([memberB.id, memberC.id]);
    const kept = members.find((member) => member.userId === memberB.id);
    expect(kept?.addedByUserId).toBe(actor.id);
    expect(kept?.addedAt).toEqual(originalAddedAt);
    const added = members.find((member) => member.userId === memberC.id);
    expect(added?.addedByUserId).toBe(secondActor.id);
  });

  it("an empty memberUserIds removes every member of that event type and none of another", async () => {
    const { memberA, memberB, standaloneEventTypeA, standaloneEventTypeB, actor } = fx();
    for (const eventTypeId of [standaloneEventTypeA.id, standaloneEventTypeB.id]) {
      await repository.updateSharing({
        eventTypeId,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: actor.id,
        sharingSetAt: SET_AT,
        memberUserIds: [memberA.id, memberB.id],
        change: changeInput({ newMode: "SELECTED_PEOPLE" }),
      });
    }

    await repository.updateSharing({
      eventTypeId: standaloneEventTypeA.id,
      sharingMode: "SELECTED_PEOPLE",
      sharingSetByUserId: actor.id,
      sharingSetAt: LATER_SET_AT,
      memberUserIds: [],
      change: changeInput({ previousMode: "SELECTED_PEOPLE", newMode: "SELECTED_PEOPLE" }),
    });

    expect(await readMembers(standaloneEventTypeA.id)).toEqual([]);
    expect((await readMembers(standaloneEventTypeB.id)).map((member) => member.userId)).toEqual([
      memberA.id,
      memberB.id,
    ]);
  });

  it("an omitted memberUserIds keeps the stored list", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;
    const { memberA, memberB, actor } = fx();
    await repository.updateSharing({
      eventTypeId,
      sharingMode: "SELECTED_PEOPLE",
      sharingSetByUserId: actor.id,
      sharingSetAt: SET_AT,
      memberUserIds: [memberA.id, memberB.id],
      change: changeInput({ newMode: "SELECTED_PEOPLE" }),
    });

    await repository.updateSharing({
      eventTypeId,
      sharingMode: "TEAM",
      sharingSetByUserId: actor.id,
      sharingSetAt: LATER_SET_AT,
      change: changeInput({ previousMode: "SELECTED_PEOPLE", newMode: "TEAM" }),
    });

    expect((await readSettings(eventTypeId))?.sharingMode).toBe("TEAM");
    expect((await readMembers(eventTypeId)).map((member) => member.userId)).toEqual([memberA.id, memberB.id]);
  });

  it("a duplicated id in memberUserIds does not throw and stores one row", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;
    const { memberA, actor } = fx();

    await repository.updateSharing({
      eventTypeId,
      sharingMode: "SELECTED_PEOPLE",
      sharingSetByUserId: actor.id,
      sharingSetAt: SET_AT,
      memberUserIds: [memberA.id, memberA.id],
      change: changeInput({ newMode: "SELECTED_PEOPLE" }),
    });

    expect((await readMembers(eventTypeId)).map((member) => member.userId)).toEqual([memberA.id]);
  });

  it("rolls the whole call back when a member id belongs to no user", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;
    const { memberA, actor, secondActor } = fx();
    await repository.updateSharing({
      eventTypeId,
      sharingMode: "TEAM",
      sharingSetByUserId: actor.id,
      sharingSetAt: SET_AT,
      memberUserIds: [memberA.id],
      change: changeInput(),
    });
    const settingsBefore = await readSettings(eventTypeId);
    const membersBefore = await readMembers(eventTypeId);
    const changeCountBefore = await countChanges(eventTypeId);

    await expect(
      repository.updateSharing({
        eventTypeId,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: secondActor.id,
        sharingSetAt: LATER_SET_AT,
        memberUserIds: [memberA.id, UNKNOWN_USER_ID],
        change: changeInput({ previousMode: "TEAM", newMode: "SELECTED_PEOPLE" }),
      })
    ).rejects.toThrow();

    expect(await readSettings(eventTypeId)).toEqual(settingsBefore);
    expect(settingsBefore?.sharingMode).toBe("TEAM");
    expect(await readMembers(eventTypeId)).toEqual(membersBefore);
    expect(await countChanges(eventTypeId)).toBe(changeCountBefore);
  });

  it("every updateSharing call adds exactly one change row", async () => {
    const eventTypeId = fx().standaloneEventTypeA.id;
    const { actor } = fx();
    const call = (sharingMode: "TEAM" | "HOSTS_ONLY", sharingSetAt: Date) =>
      repository.updateSharing({
        eventTypeId,
        sharingMode,
        sharingSetByUserId: actor.id,
        sharingSetAt,
        change: changeInput(),
      });

    await call("TEAM", SET_AT);
    expect(await countChanges(eventTypeId)).toBe(1);
    await call("HOSTS_ONLY", LATER_SET_AT);
    expect(await countChanges(eventTypeId)).toBe(2);
  });

  describe("findSharingMembersIncludeUser", () => {
    it("orders by addedAt then userId and returns the user's profile fields", async () => {
      const eventTypeId = fx().standaloneEventTypeA.id;
      const { memberA, memberB, memberC, actor } = fx();
      const earliest = new Date("2030-03-01T08:00:00.000Z");
      const tied = new Date("2030-03-02T08:00:00.000Z");
      await repository.updateSharing({
        eventTypeId,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: actor.id,
        sharingSetAt: SET_AT,
        memberUserIds: [memberA.id, memberB.id, memberC.id],
        change: changeInput({ newMode: "SELECTED_PEOPLE" }),
      });
      await prisma.eventTypeNotetakerSharingMember.update({
        where: { eventTypeId_userId: { eventTypeId, userId: memberC.id } },
        data: { addedAt: earliest },
        select: { userId: true },
      });
      for (const member of [memberA, memberB]) {
        await prisma.eventTypeNotetakerSharingMember.update({
          where: { eventTypeId_userId: { eventTypeId, userId: member.id } },
          data: { addedAt: tied },
          select: { userId: true },
        });
      }

      const members = await repository.findSharingMembersIncludeUser(eventTypeId);

      expect(members.map((member) => member.userId)).toEqual([memberC.id, memberA.id, memberB.id]);
      expect(members[0]).toEqual({
        userId: memberC.id,
        name: memberC.name,
        email: `${PREFIX}-member-c@example.com`,
        avatarUrl: null,
        addedAt: earliest,
      });
    });

    it("resolves an empty list for an event type without members", async () => {
      expect(await repository.findSharingMembersIncludeUser(fx().standaloneEventTypeB.id)).toEqual([]);
    });
  });

  it("hasSharingMember is true only for a listed user on that event type", async () => {
    const { standaloneEventTypeA, standaloneEventTypeB, memberA, memberB, actor } = fx();
    await repository.updateSharing({
      eventTypeId: standaloneEventTypeA.id,
      sharingMode: "SELECTED_PEOPLE",
      sharingSetByUserId: actor.id,
      sharingSetAt: SET_AT,
      memberUserIds: [memberA.id],
      change: changeInput({ newMode: "SELECTED_PEOPLE" }),
    });

    expect(
      await repository.hasSharingMember({ eventTypeId: standaloneEventTypeA.id, userId: memberA.id })
    ).toBe(true);
    expect(
      await repository.hasSharingMember({ eventTypeId: standaloneEventTypeA.id, userId: memberB.id })
    ).toBe(false);
    expect(
      await repository.hasSharingMember({ eventTypeId: standaloneEventTypeB.id, userId: memberA.id })
    ).toBe(false);
  });

  describe("findSharingChangesByEventTypeIdSince", () => {
    const t1 = new Date("2030-05-01T10:00:00.000Z");
    const t2 = new Date("2030-05-02T10:00:00.000Z");
    const t3 = new Date("2030-05-03T10:00:00.000Z");

    async function insertChange(eventTypeId: number, createdAt: Date, withNames: boolean) {
      const row = await prisma.eventTypeNotetakerSharingChange.create({
        data: {
          eventTypeId,
          actorUserId: fx().actor.id,
          actorName: fx().actor.name,
          previousMode: "HOSTS_ONLY",
          newMode: "TEAM",
          createdAt,
          ...(withNames ? { addedUserNames: ["Added"], removedUserNames: ["Removed"] } : {}),
        },
        select: { id: true },
      });
      return row.id;
    }

    it("returns rows from the since instant on, newest first, and respects the limit", async () => {
      const eventTypeId = fx().standaloneEventTypeA.id;
      const id1 = await insertChange(eventTypeId, t1, true);
      const id2 = await insertChange(eventTypeId, t2, true);
      const id3 = await insertChange(eventTypeId, t3, true);

      const since = await repository.findSharingChangesByEventTypeIdSince({
        eventTypeId,
        since: t2,
        limit: 10,
      });
      expect(since.map((row) => row.id)).toEqual([id3, id2]);
      expect(since.map((row) => row.createdAt)).toEqual([t3, t2]);
      expect(since[0]).toEqual({
        id: id3,
        eventTypeId,
        actorUserId: fx().actor.id,
        actorName: fx().actor.name,
        previousMode: "HOSTS_ONLY",
        newMode: "TEAM",
        addedUserNames: ["Added"],
        removedUserNames: ["Removed"],
        createdAt: t3,
      });

      const limited = await repository.findSharingChangesByEventTypeIdSince({
        eventTypeId,
        since: t1,
        limit: 1,
      });
      expect(limited.map((row) => row.id)).toEqual([id3]);
      expect(id1).not.toBe(id3);
    });

    it("leaves out rows of another event type and returns empty arrays for rows without names", async () => {
      const eventTypeId = fx().standaloneEventTypeA.id;
      const ownId = await insertChange(eventTypeId, t1, false);
      await insertChange(fx().standaloneEventTypeB.id, t2, true);

      const rows = await repository.findSharingChangesByEventTypeIdSince({
        eventTypeId,
        since: t1,
        limit: 10,
      });

      expect(rows.map((row) => row.id)).toEqual([ownId]);
      expect(rows[0]?.addedUserNames).toEqual([]);
      expect(rows[0]?.removedUserNames).toEqual([]);
    });
  });

  describe("findByTeamIdsAndSharingModeIncludeEventType", () => {
    it("resolves an empty list for no teams", async () => {
      expect(
        await repository.findByTeamIdsAndSharingModeIncludeEventType({ teamIds: [], sharingMode: "TEAM" })
      ).toEqual([]);
    });

    it("returns only the asked teams' event types whose row has the mode, ordered by id", async () => {
      const {
        subTeam,
        standaloneTeam,
        organization,
        subTeamEventType,
        standaloneEventTypeA,
        standaloneEventTypeB,
        hostsOnlyEventType,
        selectedEventType,
        otherTeamEventType,
        actor,
        memberA,
      } = fx();
      const setSharing = (
        eventTypeId: number,
        sharingMode: "TEAM" | "HOSTS_ONLY" | "SELECTED_PEOPLE",
        memberUserIds?: number[]
      ) =>
        repository.updateSharing({
          eventTypeId,
          sharingMode,
          sharingSetByUserId: actor.id,
          sharingSetAt: SET_AT,
          memberUserIds,
          change: changeInput({ newMode: sharingMode }),
        });
      await setSharing(standaloneEventTypeA.id, "TEAM");
      await setSharing(subTeamEventType.id, "TEAM");
      await setSharing(otherTeamEventType.id, "TEAM");
      await setSharing(hostsOnlyEventType.id, "HOSTS_ONLY");
      await setSharing(selectedEventType.id, "SELECTED_PEOPLE", [memberA.id]);
      expect(await repository.findByEventTypeId(standaloneEventTypeB.id)).toBeNull();

      const result = await repository.findByTeamIdsAndSharingModeIncludeEventType({
        teamIds: [subTeam.id, standaloneTeam.id],
        sharingMode: "TEAM",
      });

      expect(result).toEqual([
        {
          eventTypeId: subTeamEventType.id,
          eventTypeTitle: subTeamEventType.title,
          teamId: subTeam.id,
          teamName: subTeam.name,
          organizationId: organization.id,
          sharingMode: "TEAM",
        },
        {
          eventTypeId: standaloneEventTypeA.id,
          eventTypeTitle: standaloneEventTypeA.title,
          teamId: standaloneTeam.id,
          teamName: standaloneTeam.name,
          organizationId: null,
          sharingMode: "TEAM",
        },
      ]);
    });
  });

  describe("findBySharingMemberUserIdIncludeEventType", () => {
    it("returns the team event types the user is listed on whatever the mode, ordered by id", async () => {
      const {
        subTeam,
        standaloneTeam,
        organization,
        subTeamEventType,
        standaloneEventTypeA,
        personalEventType,
        memberA,
        memberB,
        actor,
      } = fx();
      await repository.updateSharing({
        eventTypeId: standaloneEventTypeA.id,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: actor.id,
        sharingSetAt: SET_AT,
        memberUserIds: [memberA.id],
        change: changeInput({ newMode: "SELECTED_PEOPLE" }),
      });
      await repository.updateSharing({
        eventTypeId: subTeamEventType.id,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: actor.id,
        sharingSetAt: SET_AT,
        memberUserIds: [memberA.id],
        change: changeInput({ newMode: "SELECTED_PEOPLE" }),
      });
      // Switching to TEAM without a list keeps the member row, so the person stays listed.
      await repository.updateSharing({
        eventTypeId: subTeamEventType.id,
        sharingMode: "TEAM",
        sharingSetByUserId: actor.id,
        sharingSetAt: LATER_SET_AT,
        change: changeInput({ previousMode: "SELECTED_PEOPLE", newMode: "TEAM" }),
      });
      await prisma.eventTypeNotetakerSharingMember.create({
        data: { eventTypeId: personalEventType.id, userId: memberA.id },
        select: { userId: true },
      });

      const result = await repository.findBySharingMemberUserIdIncludeEventType({ userId: memberA.id });

      expect(result).toEqual([
        {
          eventTypeId: subTeamEventType.id,
          eventTypeTitle: subTeamEventType.title,
          teamId: subTeam.id,
          teamName: subTeam.name,
          organizationId: organization.id,
          sharingMode: "TEAM",
        },
        {
          eventTypeId: standaloneEventTypeA.id,
          eventTypeTitle: standaloneEventTypeA.title,
          teamId: standaloneTeam.id,
          teamName: standaloneTeam.name,
          organizationId: null,
          sharingMode: "SELECTED_PEOPLE",
        },
      ]);
      expect(await repository.findBySharingMemberUserIdIncludeEventType({ userId: memberB.id })).toEqual([]);
    });
  });

  describe("findByEventTypeIdIncludeEventType", () => {
    it("describes a sub-team event type with the team as owner and the sharing columns", async () => {
      const { subTeamEventType, subTeam, organization, actor } = fx();
      await repository.updateSharing({
        eventTypeId: subTeamEventType.id,
        sharingMode: "TEAM",
        sharingSetByUserId: actor.id,
        sharingSetAt: SET_AT,
        change: changeInput(),
      });

      const context = await repository.findByEventTypeIdIncludeEventType(subTeamEventType.id);

      expect(context).toMatchObject({
        id: subTeamEventType.id,
        userId: null,
        teamId: subTeam.id,
        title: subTeamEventType.title,
        teamName: subTeam.name,
        organizationId: organization.id,
        ownerName: subTeam.name,
        settings: { sharingMode: "TEAM", sharingSetByUserId: actor.id, sharingSetAt: SET_AT },
      });
    });

    it("describes a personal event type with the user as owner and no team", async () => {
      const { personalEventType, actor } = fx();

      const context = await repository.findByEventTypeIdIncludeEventType(personalEventType.id);

      expect(context).toMatchObject({
        id: personalEventType.id,
        userId: actor.id,
        teamId: null,
        teamName: null,
        organizationId: null,
        ownerName: actor.name,
        settings: null,
      });
    });

    it("resolves null for an unknown event type", async () => {
      expect(await repository.findByEventTypeIdIncludeEventType(UNKNOWN_USER_ID)).toBeNull();
    });
  });

  describe("cascades", () => {
    it("deleting an event type removes its settings, member and change rows", async () => {
      const { subTeam, memberA, actor } = fx();
      const throwaway = await createEventType("cascade-event", { teamId: subTeam.id });
      await repository.updateSharing({
        eventTypeId: throwaway.id,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: actor.id,
        sharingSetAt: SET_AT,
        memberUserIds: [memberA.id],
        change: changeInput({ newMode: "SELECTED_PEOPLE" }),
      });

      await prisma.eventType.deleteMany({ where: { id: throwaway.id } });

      expect(await readSettings(throwaway.id)).toBeNull();
      expect(await readMembers(throwaway.id)).toEqual([]);
      expect(await countChanges(throwaway.id)).toBe(0);
    });

    it("deleting a listed user removes that member row and leaves the change rows", async () => {
      const { standaloneEventTypeB, memberA, actor } = fx();
      const throwawayUser = await createUser("cascade-user");
      await repository.updateSharing({
        eventTypeId: standaloneEventTypeB.id,
        sharingMode: "SELECTED_PEOPLE",
        sharingSetByUserId: actor.id,
        sharingSetAt: SET_AT,
        memberUserIds: [memberA.id, throwawayUser.id],
        change: changeInput({ newMode: "SELECTED_PEOPLE" }),
      });

      await prisma.user.deleteMany({ where: { id: throwawayUser.id } });

      expect((await readMembers(standaloneEventTypeB.id)).map((member) => member.userId)).toEqual([
        memberA.id,
      ]);
      expect(await countChanges(standaloneEventTypeB.id)).toBe(1);
    });
  });
});
