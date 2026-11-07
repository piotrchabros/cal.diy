import { prisma } from "@calcom/prisma";
import { getOrCreateDefaultOrganizationId } from "@calcom/testing/lib/defaultOrganization";
import { afterEach, describe, expect, it } from "vitest";
import { EventTypeRepository } from "./eventTypeRepository";

const uniqueId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups.length = 0;
});

// Mirrors the data the BlueBee switch-over leaves behind: an organization profile without
// movedFromUser and the user's existing event types with profileId NULL (spec 005, T325).
async function setupSwitchedOverUser() {
  const id = uniqueId();
  const organizationId = await getOrCreateDefaultOrganizationId(prisma);
  const user = await prisma.user.create({
    data: { email: `t325-${id}@example.com`, username: `t325-${id}`, organizationId },
    select: { id: true },
  });
  const profile = await prisma.profile.create({
    data: { uid: `t325-${id}`, userId: user.id, organizationId, username: `t325-${id}` },
    select: { id: true, uid: true },
  });
  const legacy = await prisma.eventType.create({
    data: { title: "Legacy", slug: `legacy-${id}`, length: 30, userId: user.id },
    select: { id: true },
  });
  const created = await prisma.eventType.create({
    data: { title: "New", slug: `new-${id}`, length: 30, userId: user.id, profileId: profile.id },
    select: { id: true },
  });
  cleanups.push(async () => {
    await prisma.eventType.deleteMany({ where: { userId: user.id } });
    await prisma.profile.delete({ where: { id: profile.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
  return { user, profile, legacy, created };
}

describe("EventTypeRepository profile lookups after the switch-over", () => {
  it("findAllByUpId returns legacy and new event types for a prof- session upId", async () => {
    const { user, profile, legacy, created } = await setupSwitchedOverUser();

    const eventTypes = await new EventTypeRepository(prisma).findAllByUpId({
      upId: `prof-${profile.uid}`,
      userId: user.id,
    });

    expect(eventTypes.map((eventType) => eventType.id).sort()).toEqual([legacy.id, created.id].sort());
  });

  it("findAllByUpIdWithMinimalData returns legacy and new event types for a prof- session upId", async () => {
    const { user, profile, legacy, created } = await setupSwitchedOverUser();

    const eventTypes = await new EventTypeRepository(prisma).findAllByUpIdWithMinimalData({
      upId: `prof-${profile.uid}`,
      userId: user.id,
    });

    expect(eventTypes.map((eventType) => eventType.id).sort()).toEqual([legacy.id, created.id].sort());
  });
});
