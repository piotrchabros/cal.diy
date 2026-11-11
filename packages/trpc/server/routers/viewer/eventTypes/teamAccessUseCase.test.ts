import { MembershipRole } from "@calcom/prisma/enums";
import { describe, expect, it } from "vitest";
import { TeamAccessUseCase } from "./teamAccessUseCase";

type Memberships = Parameters<TeamAccessUseCase["filterTeamsByEventTypeReadPermission"]>[0];

const membership = (teamId: number, accepted: boolean, isOrganization = false) =>
  ({
    teamId,
    accepted,
    role: MembershipRole.MEMBER,
    team: { id: teamId, isOrganization },
  }) as Memberships[number];

describe("TeamAccessUseCase.filterTeamsByEventTypeReadPermission", () => {
  it("keeps accepted team memberships of every role", async () => {
    const memberships = [membership(1, true), { ...membership(2, true), role: MembershipRole.OWNER }];

    await expect(new TeamAccessUseCase().filterTeamsByEventTypeReadPermission(memberships)).resolves.toEqual(
      memberships
    );
  });

  it("drops pending memberships", async () => {
    await expect(
      new TeamAccessUseCase().filterTeamsByEventTypeReadPermission([membership(1, false)])
    ).resolves.toEqual([]);
  });

  it("keeps organization memberships so the organization renders as its own tab", async () => {
    await expect(
      new TeamAccessUseCase().filterTeamsByEventTypeReadPermission([membership(1, true, true)])
    ).resolves.toEqual([membership(1, true, true)]);
  });
});
