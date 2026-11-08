import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

const prismaClient = {
  user: {
    findUnique: mocks.findUnique,
    findMany: mocks.findMany,
    update: mocks.update,
    create: mocks.create,
  },
} as unknown as PrismaClient;

const repository = new UserRepository(prismaClient);

const assertSelectOnly = (args: unknown) => {
  expect(args).toBeDefined();
  expect(args).not.toHaveProperty("include");
  expect(args).toHaveProperty("select");
};

describe("UserRepository admin users reads and writes", () => {
  it("findByIdWithOrganizationId selects only id, username and organizationId", async () => {
    const user = { id: 11, username: "ada", organizationId: 5 };
    mocks.findUnique.mockResolvedValue(user);

    await expect(repository.findByIdWithOrganizationId({ id: 11 })).resolves.toEqual(user);

    const args = mocks.findUnique.mock.calls[0][0];
    expect(args).toEqual({
      where: { id: 11 },
      select: { id: true, username: true, organizationId: true },
    });
    assertSelectOnly(args);
  });

  it("findAll selects explicit fields and never full rows", async () => {
    mocks.findMany.mockResolvedValue([]);

    await repository.findAll();

    const args = mocks.findMany.mock.calls[0][0];
    assertSelectOnly(args);
    expect(args.select).toEqual(
      expect.objectContaining({
        id: true,
        email: true,
        username: true,
        name: true,
        organizationId: true,
      })
    );
    expect(args.select).not.toHaveProperty("twoFactorSecret");
    expect(args.select).not.toHaveProperty("backupCodes");
    expect(args.select).not.toHaveProperty("password");
  });

  it("updateById forwards id and data with an explicit select", async () => {
    const updated = { id: 11, name: "Renamed" };
    mocks.update.mockResolvedValue(updated);

    await expect(repository.updateById({ id: 11, data: { name: "Renamed" } })).resolves.toEqual(updated);

    const args = mocks.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 11 });
    expect(args.data).toEqual({ name: "Renamed" });
    assertSelectOnly(args);
  });

  it("createBare creates with the given data and an explicit select", async () => {
    const created = { id: 42 };
    mocks.create.mockResolvedValue(created);

    const data = { email: "ada@example.com", username: "ada", organizationId: 5 } as const;

    await expect(repository.createBare({ ...data })).resolves.toEqual(created);

    const args = mocks.create.mock.calls[0][0];
    expect(args.data).toEqual(expect.objectContaining(data));
    assertSelectOnly(args);
  });
});
