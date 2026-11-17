import { SchedulingType } from "@calcom/prisma/enums";
import { describe, expect, it, vi } from "vitest";
import {
  AssignAllTeamMembersHostService,
  type IAssignAllTeamMembersHostServiceDeps,
} from "./AssignAllTeamMembersHostService";

type HostRow = { userId: number; eventTypeId: number; isFixed: boolean; priority: number; weight: number };

function createFakes({
  memberIdsByTeamId = {},
  eventTypes = [],
  existingHostKeys = [],
  removedCount = 0,
}: {
  memberIdsByTeamId?: Record<number, number[]>;
  eventTypes?: { id: number; teamId: number; schedulingType: SchedulingType }[];
  existingHostKeys?: string[];
  removedCount?: number;
} = {}) {
  const hostKeys = new Set(existingHostKeys);
  const createManyIgnoringDuplicates = vi.fn(async (rows: HostRow[]) => {
    let created = 0;
    for (const row of rows) {
      const key = `${row.userId}:${row.eventTypeId}`;
      if (hostKeys.has(key)) continue;
      hostKeys.add(key);
      created++;
    }
    return created;
  });
  const deleteByUserIdAndTeamIds = vi.fn(async () => removedCount);
  const findAssignAllHostedByTeamIds = vi.fn(async ({ teamIds }: { teamIds: number[] }) =>
    eventTypes.filter((eventType) => teamIds.includes(eventType.teamId))
  );
  const listAcceptedTeamMemberIds = vi.fn(
    async ({ teamId }: { teamId: number }) => memberIdsByTeamId[teamId] ?? []
  );

  const deps: IAssignAllTeamMembersHostServiceDeps = {
    hostRepository: { createManyIgnoringDuplicates, deleteByUserIdAndTeamIds },
    eventTypeRepository: { findAssignAllHostedByTeamIds },
    membershipRepository: { listAcceptedTeamMemberIds },
  };

  return {
    service: new AssignAllTeamMembersHostService(deps),
    createManyIgnoringDuplicates,
    deleteByUserIdAndTeamIds,
    findAssignAllHostedByTeamIds,
    listAcceptedTeamMemberIds,
  };
}

describe("AssignAllTeamMembersHostService", () => {
  describe("syncEventType", () => {
    it("adds every accepted member as a fixed host on a collective event type", async () => {
      const { service, createManyIgnoringDuplicates } = createFakes({ memberIdsByTeamId: { 10: [1, 2] } });

      const result = await service.syncEventType({
        eventTypeId: 100,
        teamId: 10,
        schedulingType: SchedulingType.COLLECTIVE,
      });

      expect(result).toEqual({ added: 2 });
      expect(createManyIgnoringDuplicates).toHaveBeenCalledWith([
        { userId: 1, eventTypeId: 100, isFixed: true, priority: 2, weight: 100 },
        { userId: 2, eventTypeId: 100, isFixed: true, priority: 2, weight: 100 },
      ]);
    });

    it("adds members as non-fixed hosts on a round robin event type", async () => {
      const { service, createManyIgnoringDuplicates } = createFakes({ memberIdsByTeamId: { 10: [1] } });

      await service.syncEventType({
        eventTypeId: 100,
        teamId: 10,
        schedulingType: SchedulingType.ROUND_ROBIN,
      });

      expect(createManyIgnoringDuplicates).toHaveBeenCalledWith([
        { userId: 1, eventTypeId: 100, isFixed: false, priority: 2, weight: 100 },
      ]);
    });

    it("counts only hosts that did not exist yet, relying on the repository to skip duplicates", async () => {
      const { service } = createFakes({ memberIdsByTeamId: { 10: [1, 2, 3] }, existingHostKeys: ["1:100"] });

      const result = await service.syncEventType({
        eventTypeId: 100,
        teamId: 10,
        schedulingType: SchedulingType.ROUND_ROBIN,
      });

      expect(result).toEqual({ added: 2 });
    });

    it.each([
      SchedulingType.MANAGED,
      null,
    ])("skips event types with scheduling type %s", async (schedulingType) => {
      const { service, createManyIgnoringDuplicates, listAcceptedTeamMemberIds } = createFakes({
        memberIdsByTeamId: { 10: [1] },
      });

      const result = await service.syncEventType({ eventTypeId: 100, teamId: 10, schedulingType });

      expect(result).toEqual({ added: 0 });
      expect(listAcceptedTeamMemberIds).not.toHaveBeenCalled();
      expect(createManyIgnoringDuplicates).not.toHaveBeenCalled();
    });
  });

  describe("addMemberToTeams", () => {
    it("adds the member to every assign-all event type of the given teams", async () => {
      const { service, createManyIgnoringDuplicates } = createFakes({
        eventTypes: [
          { id: 100, teamId: 10, schedulingType: SchedulingType.COLLECTIVE },
          { id: 200, teamId: 20, schedulingType: SchedulingType.ROUND_ROBIN },
          { id: 300, teamId: 30, schedulingType: SchedulingType.ROUND_ROBIN },
        ],
      });

      const result = await service.addMemberToTeams({ userId: 7, teamIds: [10, 20] });

      expect(result).toEqual({ added: 2 });
      expect(createManyIgnoringDuplicates).toHaveBeenCalledWith([
        { userId: 7, eventTypeId: 100, isFixed: true, priority: 2, weight: 100 },
        { userId: 7, eventTypeId: 200, isFixed: false, priority: 2, weight: 100 },
      ]);
    });

    it("does nothing for an empty team list", async () => {
      const { service, findAssignAllHostedByTeamIds, createManyIgnoringDuplicates } = createFakes();

      const result = await service.addMemberToTeams({ userId: 7, teamIds: [] });

      expect(result).toEqual({ added: 0 });
      expect(findAssignAllHostedByTeamIds).not.toHaveBeenCalled();
      expect(createManyIgnoringDuplicates).not.toHaveBeenCalled();
    });
  });

  describe("removeMemberFromTeams", () => {
    it("removes the member's hosts from the given teams' event types", async () => {
      const { service, deleteByUserIdAndTeamIds } = createFakes({ removedCount: 3 });

      const result = await service.removeMemberFromTeams({ userId: 7, teamIds: [10, 20] });

      expect(result).toEqual({ removed: 3 });
      expect(deleteByUserIdAndTeamIds).toHaveBeenCalledWith({ userId: 7, teamIds: [10, 20] });
    });

    it("does nothing for an empty team list", async () => {
      const { service, deleteByUserIdAndTeamIds } = createFakes();

      const result = await service.removeMemberFromTeams({ userId: 7, teamIds: [] });

      expect(result).toEqual({ removed: 0 });
      expect(deleteByUserIdAndTeamIds).not.toHaveBeenCalled();
    });
  });
});
