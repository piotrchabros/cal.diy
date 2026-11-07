import type { PrismaClient } from "@calcom/prisma/client";
import { describe, expect, it, vi } from "vitest";
import { EventTypeRepository } from "../eventTypeRepository";

describe("EventTypeRepository.findByIdIncludeTeamAndOwnerOrganization", () => {
  it("selects only the fields that decide the event type's organization", async () => {
    const row = { id: 4, team: null, parent: null, owner: { organizationId: 7 } };
    const findUnique = vi.fn().mockResolvedValue(row);
    const repo = new EventTypeRepository({ eventType: { findUnique } } as unknown as PrismaClient);

    await expect(repo.findByIdIncludeTeamAndOwnerOrganization({ id: 4 })).resolves.toBe(row);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 4 },
      select: {
        id: true,
        team: { select: { id: true, parentId: true, isOrganization: true } },
        parent: { select: { team: { select: { parentId: true } } } },
        owner: { select: { organizationId: true } },
      },
    });
  });
});
