import type { PrismaClient } from "@calcom/prisma";
import { describe, expect, it, vi } from "vitest";
import { PrismaOrganizationNotetakerSettingsRepository } from "./PrismaOrganizationNotetakerSettingsRepository";

const updatedAt = new Date("2030-01-01T00:00:00.000Z");
const record = { organizationId: 7, botName: "Scribe", botImageUpdatedAt: updatedAt };

function buildRepository() {
  const settingsFindUnique = vi.fn();
  const settingsUpsert = vi.fn().mockResolvedValue(record);
  const userFindUnique = vi.fn();
  const prismaClient = {
    organizationNotetakerSettings: { findUnique: settingsFindUnique, upsert: settingsUpsert },
    user: { findUnique: userFindUnique },
  } as unknown as PrismaClient;
  return {
    repository: new PrismaOrganizationNotetakerSettingsRepository(prismaClient),
    settingsFindUnique,
    settingsUpsert,
    userFindUnique,
  };
}

describe("PrismaOrganizationNotetakerSettingsRepository", () => {
  it("never selects the image blob when reading the record", async () => {
    const { repository, settingsFindUnique } = buildRepository();
    settingsFindUnique.mockResolvedValue(record);

    expect(await repository.findByOrganizationId(7)).toEqual(record);

    const { select } = settingsFindUnique.mock.calls[0][0];
    expect(select).toEqual({ organizationId: true, botName: true, botImageUpdatedAt: true });
    expect(select).not.toHaveProperty("botImageJpeg");
  });

  it("reads the blob only through findBotImageByOrganizationId", async () => {
    const { repository, settingsFindUnique } = buildRepository();
    settingsFindUnique.mockResolvedValueOnce({ botImageJpeg: "AAAA" }).mockResolvedValueOnce(null);

    expect(await repository.findBotImageByOrganizationId(7)).toBe("AAAA");
    expect(await repository.findBotImageByOrganizationId(8)).toBeNull();
    expect(settingsFindUnique.mock.calls[0][0].select).toEqual({ botImageJpeg: true });
  });

  it("upserts the bot name without touching the image fields", async () => {
    const { repository, settingsUpsert } = buildRepository();

    await repository.upsertBotName(7, "Scribe");

    const args = settingsUpsert.mock.calls[0][0];
    expect(args.create).toEqual({ organizationId: 7, botName: "Scribe" });
    expect(args.update).toEqual({ botName: "Scribe" });
    expect(args.select).not.toHaveProperty("botImageJpeg");
  });

  it("stores the image together with its timestamp", async () => {
    const { repository, settingsUpsert } = buildRepository();

    await repository.upsertBotImage(7, "AAAA", updatedAt);

    const args = settingsUpsert.mock.calls[0][0];
    expect(args.update).toEqual({ botImageJpeg: "AAAA", botImageUpdatedAt: updatedAt });
    expect(args.create).toEqual({ organizationId: 7, botImageJpeg: "AAAA", botImageUpdatedAt: updatedAt });
    expect(args.select).not.toHaveProperty("botImageJpeg");
  });

  it("clears both the image and its timestamp when the image is null", async () => {
    const { repository, settingsUpsert } = buildRepository();

    await repository.upsertBotImage(7, null, updatedAt);

    expect(settingsUpsert.mock.calls[0][0].update).toEqual({ botImageJpeg: null, botImageUpdatedAt: null });
  });

  it("maps the user's organization settings", async () => {
    const { repository, userFindUnique } = buildRepository();
    userFindUnique.mockResolvedValue({ organization: { notetakerOrganizationSettings: record } });

    expect(await repository.findByUserId(3)).toEqual(record);
    expect(userFindUnique.mock.calls[0][0].where).toEqual({ id: 3 });
  });

  it("returns null for a user whose organization has no settings", async () => {
    const { repository, userFindUnique } = buildRepository();
    userFindUnique.mockResolvedValue({ organization: { notetakerOrganizationSettings: null } });

    expect(await repository.findByUserId(3)).toBeNull();
  });

  it("returns null for an unknown user", async () => {
    const { repository, userFindUnique } = buildRepository();
    userFindUnique.mockResolvedValue(null);

    expect(await repository.findByUserId(-1)).toBeNull();
  });
});
