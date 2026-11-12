import { prisma } from "@calcom/prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isQuickstartIsolatedDatabase } from "../tests/quickstartHarness";
import { PrismaOrganizationNotetakerSettingsRepository } from "./PrismaOrganizationNotetakerSettingsRepository";

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PREFIX = `org-notetaker-settings-it-${runId}`;

// The default DATABASE_URL of this checkout is a live site's database, so the file runs only
// against the scratch database.
const RUNS_ON_ISOLATED_DATABASE: boolean = isQuickstartIsolatedDatabase();

const SUITE = "PrismaOrganizationNotetakerSettingsRepository (integration)";
const SET_AT = new Date("2030-04-01T09:00:00.000Z");
// Ids are autoincrement and positive, so -1 never matches a real user.
const UNKNOWN_USER_ID = -1;

const repository = new PrismaOrganizationNotetakerSettingsRepository(prisma);

let organizationId = 0;
let otherOrganizationId = 0;
let userId = 0;

describe.skipIf(!RUNS_ON_ISOLATED_DATABASE)(SUITE, () => {
  beforeAll(async () => {
    const organization = await prisma.team.create({
      data: { name: `${PREFIX}-org`, slug: `${PREFIX}-org`, isOrganization: true },
      select: { id: true },
    });
    const otherOrganization = await prisma.team.create({
      data: { name: `${PREFIX}-other`, slug: `${PREFIX}-other`, isOrganization: true },
      select: { id: true },
    });
    const user = await prisma.user.create({
      data: {
        organizationId: organization.id,
        email: `${PREFIX}@example.com`,
        username: PREFIX,
        name: PREFIX,
      },
      select: { id: true },
    });
    organizationId = organization.id;
    otherOrganizationId = otherOrganization.id;
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.organizationNotetakerSettings.deleteMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
    });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.team.deleteMany({ where: { id: { in: [organizationId, otherOrganizationId] } } });
  });

  it("returns null before any settings exist", async () => {
    expect(await repository.findByOrganizationId(organizationId)).toBeNull();
    expect(await repository.findByUserId(userId)).toBeNull();
    expect(await repository.findBotImageByOrganizationId(organizationId)).toBeNull();
  });

  it("returns null for an unknown user", async () => {
    expect(await repository.findByUserId(UNKNOWN_USER_ID)).toBeNull();
  });

  it("creates then updates the bot name", async () => {
    const created = await repository.upsertBotName(organizationId, "Scribe");
    expect(created).toEqual({ organizationId, botName: "Scribe", botImageUpdatedAt: null });

    const cleared = await repository.upsertBotName(organizationId, null);
    expect(cleared.botName).toBeNull();
  });

  it("stores the image without exposing it on the record, and clears it with its timestamp", async () => {
    const stored = await repository.upsertBotImage(organizationId, "AAAA", SET_AT);
    expect(stored.botImageUpdatedAt).toEqual(SET_AT);
    expect(stored).not.toHaveProperty("botImageJpeg");
    expect(await repository.findBotImageByOrganizationId(organizationId)).toBe("AAAA");

    const cleared = await repository.upsertBotImage(organizationId, null, SET_AT);
    expect(cleared.botImageUpdatedAt).toBeNull();
    expect(await repository.findBotImageByOrganizationId(organizationId)).toBeNull();
  });

  it("keeps the bot name when the image changes", async () => {
    await repository.upsertBotName(organizationId, "Keeper");
    await repository.upsertBotImage(organizationId, "BBBB", SET_AT);

    expect((await repository.findByOrganizationId(organizationId))?.botName).toBe("Keeper");
  });

  it("resolves the settings of the organization the user belongs to", async () => {
    const record = await repository.findByUserId(userId);

    expect(record?.organizationId).toBe(organizationId);
    expect(await repository.findByOrganizationId(otherOrganizationId)).toBeNull();
  });
});
