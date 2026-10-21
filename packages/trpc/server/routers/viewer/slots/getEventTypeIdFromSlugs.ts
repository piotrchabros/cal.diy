import type { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";

type Deps = {
  eventTypeRepo: Pick<EventTypeRepository, "findFirstEventTypeId" | "findFirstIdByTeamSlugAndSlug">;
  getUserIdByUsername: (username: string) => Promise<number | undefined>;
};

// A team slug must never be resolved as a username, and a missing user must never fall back to a
// slug-only lookup: both would return an arbitrary event type that happens to share the slug.
export async function getEventTypeIdFromSlugs(
  { eventTypeRepo, getUserIdByUsername }: Deps,
  {
    ownerSlug,
    eventTypeSlug,
    isTeamEvent,
  }: { ownerSlug: string; eventTypeSlug: string; isTeamEvent: boolean }
): Promise<number | null> {
  if (isTeamEvent) {
    const teamEventType = await eventTypeRepo.findFirstIdByTeamSlugAndSlug({
      teamSlug: ownerSlug,
      slug: eventTypeSlug,
    });
    return teamEventType?.id ?? null;
  }

  const userId = await getUserIdByUsername(ownerSlug);
  if (userId === undefined) return null;

  const userEventType = await eventTypeRepo.findFirstEventTypeId({ slug: eventTypeSlug, userId });
  return userEventType?.id ?? null;
}
