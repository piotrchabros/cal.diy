import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { PrismaOrganizationSmtpSettingsRepository } from "./PrismaOrganizationSmtpSettingsRepository";

const row = {
  organizationId: 7,
  host: "smtp.acme.com",
  port: 587,
  security: "STARTTLS",
  username: "mailer",
  passwordEncrypted: "enc",
  lastVerifiedAt: null,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};
const selectShape = {
  organizationId: true,
  host: true,
  port: true,
  security: true,
  username: true,
  passwordEncrypted: true,
  lastVerifiedAt: true,
  updatedAt: true,
};

function buildRepository() {
  const findUnique = vi.fn();
  const upsert = vi.fn();
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prismaClient = {
    organizationSmtpSettings: { findUnique, upsert, deleteMany, updateMany },
  } as unknown as PrismaClient;
  return {
    repository: new PrismaOrganizationSmtpSettingsRepository(prismaClient),
    findUnique,
    upsert,
    deleteMany,
    updateMany,
  };
}

describe("PrismaOrganizationSmtpSettingsRepository", () => {
  it("reads settings with an explicit select", async () => {
    const { repository, findUnique } = buildRepository();
    findUnique.mockResolvedValue(row);

    expect(await repository.findByOrganizationId(7)).toEqual(row);
    expect(findUnique).toHaveBeenCalledWith({ where: { organizationId: 7 }, select: selectShape });
  });

  it("returns null when no settings exist", async () => {
    const { repository, findUnique } = buildRepository();
    findUnique.mockResolvedValue(null);

    expect(await repository.findByOrganizationId(7)).toBeNull();
  });

  it("throws on an unknown security value", async () => {
    const { repository, findUnique } = buildRepository();
    findUnique.mockResolvedValue({ ...row, security: "WEIRD" });

    await expect(repository.findByOrganizationId(7)).rejects.toThrow("Unknown organization SMTP security");
  });

  it("upserts with the same data on create and update", async () => {
    const { repository, upsert } = buildRepository();
    upsert.mockResolvedValue(row);
    const data = {
      host: "smtp.acme.com",
      port: 587,
      security: "STARTTLS" as const,
      username: "mailer",
      passwordEncrypted: "enc",
    };

    expect(await repository.upsert(7, data)).toEqual(row);
    expect(upsert).toHaveBeenCalledWith({
      where: { organizationId: 7 },
      create: { organizationId: 7, ...data },
      update: data,
      select: selectShape,
    });
  });

  it("deletes idempotently via deleteMany", async () => {
    const { repository, deleteMany } = buildRepository();

    await expect(repository.delete(7)).resolves.toBeUndefined();
    expect(deleteMany).toHaveBeenCalledWith({ where: { organizationId: 7 } });
  });

  it("marks verified via updateMany", async () => {
    const { repository, updateMany } = buildRepository();
    const at = new Date("2026-02-02T00:00:00Z");

    await repository.markVerified(7, at);
    expect(updateMany).toHaveBeenCalledWith({ where: { organizationId: 7 }, data: { lastVerifiedAt: at } });
  });
});
