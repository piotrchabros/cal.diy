import prismock from "../__mocks__/prisma";
import { describe, expect, it } from "vitest";
import {
  addUsersToDb,
  createBookingScenario,
  getOrganizer,
  getScenarioData,
  SCENARIO_DEFAULT_ORGANIZATION_ID,
  TestData,
} from "./bookingScenario";

function buildUser({ id, organizationId }: { id: number; organizationId?: number | null }) {
  return getOrganizer({
    name: `Organizer ${id}`,
    email: `organizer-${id}@example.com`,
    id,
    organizationId,
    schedules: [TestData.schedules.IstWorkHours],
  });
}

async function findDefaultOrganizations() {
  return prismock.team.findMany({
    where: { id: SCENARIO_DEFAULT_ORGANIZATION_ID },
    select: { id: true, isOrganization: true },
  });
}

describe("addUsersToDb", () => {
  it("assigns the scenario default organization to a user without organizationId", async () => {
    const { organizationId: _omitted, ...userWithoutOrganization } = buildUser({ id: 101 });

    await addUsersToDb([userWithoutOrganization]);

    const user = await prismock.user.findUnique({ where: { id: 101 }, select: { organizationId: true } });
    expect(user?.organizationId).toBe(SCENARIO_DEFAULT_ORGANIZATION_ID);
    expect(await findDefaultOrganizations()).toEqual([
      { id: SCENARIO_DEFAULT_ORGANIZATION_ID, isOrganization: true },
    ]);
  });

  it("assigns the scenario default organization to a user with organizationId null", async () => {
    await addUsersToDb([buildUser({ id: 102, organizationId: null })]);

    const user = await prismock.user.findUnique({ where: { id: 102 }, select: { organizationId: true } });
    expect(user?.organizationId).toBe(SCENARIO_DEFAULT_ORGANIZATION_ID);
  });

  it("keeps an explicit organizationId and creates no default organization when every user has one", async () => {
    await addUsersToDb([buildUser({ id: 103, organizationId: 55 })]);

    const user = await prismock.user.findUnique({ where: { id: 103 }, select: { organizationId: true } });
    expect(user?.organizationId).toBe(55);
    expect(await findDefaultOrganizations()).toEqual([]);
  });

  it("leaves exactly one default organization row after repeated calls", async () => {
    await addUsersToDb([buildUser({ id: 104 })]);
    await addUsersToDb([buildUser({ id: 105 })]);

    expect(await findDefaultOrganizations()).toHaveLength(1);
  });
});

describe("createBookingScenario", () => {
  it("keeps a team fixture with id 1 a non-organization team", async () => {
    const organizer = getOrganizer({
      name: "Organizer",
      email: "organizer@example.com",
      id: 106,
      schedules: [TestData.schedules.IstWorkHours],
      teams: [{ membership: { accepted: true }, team: { id: 1, name: "Team 1", slug: "team-1" } }],
    });

    await createBookingScenario(
      getScenarioData({
        eventTypes: [{ id: 1, slotInterval: 30, length: 30, users: [{ id: 106 }] }],
        organizer,
      })
    );

    const team = await prismock.team.findUnique({ where: { id: 1 }, select: { isOrganization: true } });
    expect(team?.isOrganization).toBe(false);
    const user = await prismock.user.findUnique({ where: { id: 106 }, select: { organizationId: true } });
    expect(user?.organizationId).toBe(SCENARIO_DEFAULT_ORGANIZATION_ID);
  });
});
