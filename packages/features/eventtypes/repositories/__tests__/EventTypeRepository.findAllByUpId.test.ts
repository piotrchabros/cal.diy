import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import type { PrismaClient } from "@calcom/prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventTypeRepository } from "../eventTypeRepository";

type ProfileById = Awaited<ReturnType<typeof ProfileRepository.findById>>;
type ProfileByUid = Awaited<ReturnType<typeof ProfileRepository.findByUid>>;

const PROFILE_ID = 3;
const USER_ID = 5;

function setup({ profile }: { profile: { movedFromUser: { id: number } | null } | null }) {
  const findMany = vi.fn().mockResolvedValue([]);
  const repo = new EventTypeRepository({ eventType: { findMany } } as unknown as PrismaClient);
  vi.spyOn(ProfileRepository, "findByUid").mockResolvedValue({ id: PROFILE_ID } as unknown as ProfileByUid);
  vi.spyOn(ProfileRepository, "findById").mockResolvedValue(
    (profile ? { id: PROFILE_ID, user: { id: USER_ID }, ...profile } : null) as unknown as ProfileById
  );
  return { repo, findMany };
}

const methods = ["findAllByUpId", "findAllByUpIdWithMinimalData"] as const;

describe.each(methods)("EventTypeRepository.%s", (method) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes the profile user's legacy event types when the profile has no movedFromUser", async () => {
    const { repo, findMany } = setup({ profile: { movedFromUser: null } });

    await repo[method]({ upId: "prof-abc", userId: USER_ID }, { where: { hidden: false } });

    expect(ProfileRepository.findByUid).toHaveBeenCalledWith("abc");
    expect(ProfileRepository.findById).toHaveBeenCalledWith(PROFILE_ID);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({
      OR: [
        { profileId: PROFILE_ID },
        { userId: USER_ID, parentId: { not: null } },
        { userId: USER_ID, profileId: null },
      ],
      hidden: false,
    });
  });

  it("uses movedFromUser for the legacy event types when it is set", async () => {
    const { repo, findMany } = setup({ profile: { movedFromUser: { id: 9 } } });

    await repo[method]({ upId: "prof-abc", userId: USER_ID });

    expect(findMany.mock.calls[0][0].where.OR).toContainEqual({ userId: 9, profileId: null });
    expect(findMany.mock.calls[0][0].where.OR).not.toContainEqual({ userId: USER_ID, profileId: null });
  });

  it("only matches the profile and children when the profile is not found", async () => {
    const { repo, findMany } = setup({ profile: null });

    await repo[method]({ upId: "prof-abc", userId: USER_ID });

    expect(findMany.mock.calls[0][0].where).toEqual({
      OR: [{ profileId: PROFILE_ID }, { userId: USER_ID, parentId: { not: null } }],
    });
  });

  it("looks up by userId for a usr- upId", async () => {
    const { repo, findMany } = setup({ profile: null });

    await repo[method]({ upId: `usr-${USER_ID}`, userId: USER_ID });

    expect(ProfileRepository.findById).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0][0].where).toEqual({ userId: USER_ID });
  });
});
