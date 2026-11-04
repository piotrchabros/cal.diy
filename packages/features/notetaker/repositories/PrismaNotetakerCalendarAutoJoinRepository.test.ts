import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { PrismaNotetakerCalendarAutoJoinRepository } from "./PrismaNotetakerCalendarAutoJoinRepository";

function buildRepository(rows: unknown[] = []) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prismaClient = { notetakerCalendarAutoJoin: { findMany } } as unknown as PrismaClient;
  return { repository: new PrismaNotetakerCalendarAutoJoinRepository(prismaClient), findMany };
}

describe("PrismaNotetakerCalendarAutoJoinRepository.findDueForPoll", () => {
  const polledBefore = new Date("2026-11-04T10:00:00.000Z");

  it("filters to enabled, due, user-level calendars of the given integrations, never-polled first", async () => {
    const { repository, findMany } = buildRepository();

    await repository.findDueForPoll({ polledBefore, integrations: ["google_calendar"], limit: 20 });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      enabled: true,
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: polledBefore } }],
      selectedCalendar: { eventTypeId: null, integration: { in: ["google_calendar"] } },
    });
    expect(args.orderBy).toEqual([{ lastPolledAt: { sort: "asc", nulls: "first" } }]);
    expect(args.take).toBe(20);
  });

  it("skips the query when no integration is supported", async () => {
    const { repository, findMany } = buildRepository();

    await expect(repository.findDueForPoll({ polledBefore, integrations: [], limit: 20 })).resolves.toEqual(
      []
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("flattens the selected calendar into the gateway record", async () => {
    const { repository } = buildRepository([
      {
        selectedCalendarId: "sc-1",
        userId: 7,
        sharingTeamId: 3,
        lastPolledAt: null,
        selectedCalendar: {
          integration: "google_calendar",
          externalId: "a@b.c",
          credentialId: 5,
          delegationCredentialId: null,
        },
      },
    ]);

    const [record] = await repository.findDueForPoll({
      polledBefore,
      integrations: ["google_calendar"],
      limit: 1,
    });

    expect(record).toEqual({
      selectedCalendarId: "sc-1",
      userId: 7,
      integration: "google_calendar",
      externalId: "a@b.c",
      credentialId: 5,
      delegationCredentialId: null,
      sharingTeamId: 3,
      lastPolledAt: null,
    });
  });
});
