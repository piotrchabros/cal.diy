import { ErrorWithCode } from "@calcom/lib/errors";
import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { CreationSource } from "@calcom/prisma/enums";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TAddUserInput } from "./add.handler";
import { addUserHandler } from "./add.handler";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getDefault: vi.fn(),
  addMember: vi.fn(),
  storeAdminUserAvatar: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
}));

vi.mock("@calcom/features/organizations/di/OrganizationService.container", () => ({
  getOrganizationService: () => ({ get: mocks.get, getDefault: mocks.getDefault }),
}));

vi.mock("@calcom/features/organizations/di/OrganizationMembershipService.container", () => ({
  getOrganizationMembershipService: () => ({ addMember: mocks.addMember }),
}));

vi.mock("./adminUserAvatar", () => ({
  isImageDataUrl: (value: unknown) => typeof value === "string" && value.startsWith("data:image/"),
  storeAdminUserAvatar: mocks.storeAdminUserAvatar,
}));

const prisma = {
  user: { create: mocks.userCreate, update: mocks.userUpdate, delete: mocks.userDelete },
} as unknown as PrismaClient;

const baseInput = { name: "Ada", email: "ada@example.com", username: "ada" } as TAddUserInput;

const runAdd = (input: Partial<TAddUserInput> = {}) =>
  addUserHandler({ ctx: { prisma }, input: { ...baseInput, ...input } });

const createdData = () => mocks.userCreate.mock.calls[0][0].data;

describe("addUserHandler", () => {
  beforeEach(() => {
    mocks.userCreate.mockImplementation(async ({ data }) => ({ id: 42, ...data }));
    mocks.userUpdate.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
    mocks.get.mockImplementation(async (id: number) => ({ id }));
    mocks.getDefault.mockResolvedValue({ id: 1 });
    mocks.addMember.mockResolvedValue({ userId: 42, organizationId: 1, role: "MEMBER" });
    mocks.storeAdminUserAvatar.mockResolvedValue("https://cdn.example.com/avatar.png");
    mocks.userDelete.mockImplementation(async ({ where }) => ({ id: where.id }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  describe("with ORGANIZATIONS_ENABLED off", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "");
    });

    it("creates the user as before and ignores organizationId", async () => {
      const result = await runAdd({ organizationId: 9 });

      expect(createdData()).toEqual({
        name: "Ada",
        email: "ada@example.com",
        username: "ada",
        avatarUrl: undefined,
        creationSource: CreationSource.WEBAPP,
      });
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.getDefault).not.toHaveBeenCalled();
      expect(mocks.addMember).not.toHaveBeenCalled();
      expect(result.message).toBe("User with id: 42 added successfully");
    });

    it("does not require a username", async () => {
      await runAdd({ username: null });

      expect(mocks.userCreate).toHaveBeenCalledOnce();
    });

    it("stores an uploaded avatar instead of the data URL", async () => {
      const result = await runAdd({ avatarUrl: "data:image/png;base64,AAAA" });

      expect(createdData().avatarUrl).toBeNull();
      expect(mocks.storeAdminUserAvatar).toHaveBeenCalledWith(42, "data:image/png;base64,AAAA");
      expect(result.user.avatarUrl).toBe("https://cdn.example.com/avatar.png");
    });
  });

  describe("with ORGANIZATIONS_ENABLED on", () => {
    beforeEach(() => {
      vi.stubEnv("ORGANIZATIONS_ENABLED", "1");
    });

    it("adds the user to the default organization when none is given", async () => {
      const result = await runAdd();

      expect(mocks.getDefault).toHaveBeenCalledOnce();
      expect(createdData()).toEqual(
        expect.objectContaining({ organizationId: 1, creationSource: CreationSource.WEBAPP })
      );
      expect(mocks.addMember).toHaveBeenCalledWith({ organizationId: 1, userId: 42, role: "MEMBER" });
      expect(result.message).toBe("User with id: 42 added successfully");
    });

    it("adds the user to the requested organization", async () => {
      await runAdd({ organizationId: 7 });

      expect(mocks.get).toHaveBeenCalledWith(7);
      expect(mocks.getDefault).not.toHaveBeenCalled();
      expect(createdData().organizationId).toBe(7);
      expect(mocks.addMember).toHaveBeenCalledWith({ organizationId: 7, userId: 42, role: "MEMBER" });
    });

    it("rejects an unknown organization with NOT_FOUND and creates no user", async () => {
      mocks.get.mockRejectedValue(ErrorWithCode.Factory.NotFound("Organization not found"));

      await expect(runAdd({ organizationId: 404 })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Organization not found",
      });
      expect(mocks.userCreate).not.toHaveBeenCalled();
    });

    it("rejects a missing username with BAD_REQUEST", async () => {
      const error = await runAdd({ username: null }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({ code: "BAD_REQUEST" });
      expect(mocks.userCreate).not.toHaveBeenCalled();
      expect(mocks.getDefault).not.toHaveBeenCalled();
    });

    it("maps a unique constraint violation to CONFLICT", async () => {
      mocks.userCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        })
      );

      await expect(runAdd()).rejects.toMatchObject({ code: "CONFLICT" });
      expect(mocks.addMember).not.toHaveBeenCalled();
    });

    it("converts membership errors to tRPC errors", async () => {
      mocks.addMember.mockRejectedValue(
        ErrorWithCode.Factory.Conflict("Username is already taken in this organization")
      );

      await expect(runAdd()).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("deletes the created user when joining the organization fails", async () => {
      mocks.addMember.mockRejectedValue(
        ErrorWithCode.Factory.Conflict("Username is already taken in this organization")
      );

      const error = await runAdd().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({
        code: "CONFLICT",
        message: "Username is already taken in this organization",
      });
      expect(mocks.userDelete).toHaveBeenCalledWith({ where: { id: 42 }, select: { id: true } });
    });

    it("keeps the created user when joining the organization succeeds", async () => {
      await runAdd();

      expect(mocks.userDelete).not.toHaveBeenCalled();
    });

    it("stores an uploaded avatar after joining the organization", async () => {
      const result = await runAdd({ avatarUrl: "data:image/png;base64,AAAA" });

      expect(createdData().avatarUrl).toBeNull();
      expect(mocks.addMember).toHaveBeenCalledOnce();
      expect(mocks.storeAdminUserAvatar).toHaveBeenCalledWith(42, "data:image/png;base64,AAAA");
      expect(result.user.avatarUrl).toBe("https://cdn.example.com/avatar.png");
    });
  });
});
