jest.mock("@calcom/platform-libraries", () => ({ CreationSource: {} }), { virtual: true });
jest.mock("uuid", () => ({ v4: () => "uid-1" }));

import { UsersRepository } from "./users.repository";
import type { PrismaReadService } from "@/modules/prisma/prisma-read.service";
import type { PrismaWriteService } from "@/modules/prisma/prisma-write.service";

describe("UsersRepository.updateUsernameAndUpsertOrgProfile", () => {
  it("renames the user and upserts their org profile in one transaction", async () => {
    const userUpdate = jest.fn().mockReturnValue("user-update");
    const profileUpsert = jest.fn().mockReturnValue("profile-upsert");
    const $transaction = jest.fn().mockResolvedValue([]);
    const dbWrite = {
      prisma: { user: { update: userUpdate }, profile: { upsert: profileUpsert }, $transaction },
    } as unknown as PrismaWriteService;
    const repository = new UsersRepository({} as unknown as PrismaReadService, dbWrite);

    await repository.updateUsernameAndUpsertOrgProfile(3, 7, "new-name");

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { username: "new-name" },
      select: { id: true },
    });
    expect(profileUpsert).toHaveBeenCalledWith({
      where: { userId_organizationId: { userId: 3, organizationId: 7 } },
      create: { uid: "uid-1", userId: 3, organizationId: 7, username: "new-name" },
      update: { username: "new-name" },
      select: { id: true },
    });
    expect($transaction).toHaveBeenCalledWith(["user-update", "profile-upsert"]);
  });

  it("propagates a transaction failure so neither write is kept", async () => {
    const failure = new Error("Unique constraint failed");
    const dbWrite = {
      prisma: {
        user: { update: jest.fn() },
        profile: { upsert: jest.fn() },
        $transaction: jest.fn().mockRejectedValue(failure),
      },
    } as unknown as PrismaWriteService;
    const repository = new UsersRepository({} as unknown as PrismaReadService, dbWrite);

    await expect(repository.updateUsernameAndUpsertOrgProfile(3, 7, "taken")).rejects.toBe(failure);
  });
});
