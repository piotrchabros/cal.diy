import type { OrganizationRoleDto } from "@calcom/lib/dto/OrganizationDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTETAKER_BOT_IMAGE_HEIGHT,
  NOTETAKER_BOT_IMAGE_MAX_BYTES,
  NOTETAKER_BOT_IMAGE_WIDTH,
} from "../lib/botImage";
import type {
  IOrganizationNotetakerSettingsRepository,
  OrganizationNotetakerSettingsRecord,
} from "../repositories/interfaces/IOrganizationNotetakerSettingsRepository";
import { OrganizationNotetakerSettingsService } from "./OrganizationNotetakerSettingsService";

const mocks = vi.hoisted(() => ({ encodeJpegCover: vi.fn() }));

vi.mock("@calcom/lib/server/imageUtils", () => ({ encodeJpegCover: mocks.encodeJpegCover }));

const ORGANIZATION_ID = 5;
const ACTOR_ID = 7;
const ENCODED_JPEG = Buffer.from("encoded-jpeg");
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;

class InMemorySettingsRepository implements IOrganizationNotetakerSettingsRepository {
  record: OrganizationNotetakerSettingsRecord | null = null;
  image: string | null = null;
  imageReads = 0;

  async findByOrganizationId(organizationId: number) {
    return this.record?.organizationId === organizationId ? { ...this.record } : null;
  }

  async findByUserId() {
    return this.record ? { ...this.record } : null;
  }

  async findBotImageByOrganizationId() {
    this.imageReads++;
    return this.image;
  }

  async upsertBotName(organizationId: number, botName: string | null) {
    this.record = { organizationId, botImageUpdatedAt: null, ...this.record, botName };
    return { ...this.record };
  }

  async upsertBotImage(organizationId: number, botImageJpeg: string | null, at: Date) {
    this.image = botImageJpeg;
    this.record = {
      organizationId,
      botName: null,
      ...this.record,
      botImageUpdatedAt: botImageJpeg ? at : null,
    };
    return { ...this.record };
  }
}

async function expectRejection(promise: Promise<unknown>, code: ErrorCode, message: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ErrorWithCode);
  if (!(error instanceof ErrorWithCode)) return;
  expect(error.code).toBe(code);
  expect(error.message).toBe(message);
}

describe("OrganizationNotetakerSettingsService", () => {
  let repository: InMemorySettingsRepository;
  let role: OrganizationRoleDto | null;
  let botName: string | null;
  let service: OrganizationNotetakerSettingsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.encodeJpegCover.mockResolvedValue(ENCODED_JPEG);
    repository = new InMemorySettingsRepository();
    role = "ADMIN";
    botName = "Acme Notetaker";
    service = new OrganizationNotetakerSettingsService({
      settingsRepository: repository,
      organizationMembershipService: { getRole: async () => role },
      config: {
        get botName() {
          return botName;
        },
      },
    });
  });

  const update = (fields: { botName?: string | null; botImage?: string | null }) =>
    service.update({ organizationId: ORGANIZATION_ID, actorUserId: ACTOR_ID, ...fields });

  describe("get", () => {
    it("returns empty settings with the configured fallback name", async () => {
      await expect(service.get({ organizationId: ORGANIZATION_ID, viewerUserId: ACTOR_ID })).resolves.toEqual(
        {
          botName: null,
          botImageDataUrl: null,
          fallbackBotName: "Acme Notetaker",
          canEdit: true,
        }
      );
    });

    it("returns a null fallback name when none is configured", async () => {
      botName = null;

      const dto = await service.get({ organizationId: ORGANIZATION_ID, viewerUserId: ACTOR_ID });

      expect(dto.fallbackBotName).toBeNull();
    });

    it("lets a member read but not edit", async () => {
      role = "MEMBER";

      const dto = await service.get({ organizationId: ORGANIZATION_ID, viewerUserId: ACTOR_ID });

      expect(dto.canEdit).toBe(false);
    });

    it("hides the settings from a non-member", async () => {
      role = null;

      await expectRejection(
        service.get({ organizationId: ORGANIZATION_ID, viewerUserId: ACTOR_ID }),
        ErrorCode.NotFound,
        "organization_not_found"
      );
    });

    it("loads the image only when one has been set", async () => {
      await repository.upsertBotName(ORGANIZATION_ID, "Scribe");

      const withoutImage = await service.get({ organizationId: ORGANIZATION_ID, viewerUserId: ACTOR_ID });

      expect(withoutImage).toMatchObject({ botName: "Scribe", botImageDataUrl: null });
      expect(repository.imageReads).toBe(0);

      await repository.upsertBotImage(ORGANIZATION_ID, "c3RvcmVk", new Date());

      const withImage = await service.get({ organizationId: ORGANIZATION_ID, viewerUserId: ACTOR_ID });

      expect(withImage.botImageDataUrl).toBe("data:image/jpeg;base64,c3RvcmVk");
      expect(repository.imageReads).toBe(1);
    });
  });

  describe("update", () => {
    it("hides the settings from a non-member", async () => {
      role = null;

      await expectRejection(update({ botName: "Scribe" }), ErrorCode.NotFound, "organization_not_found");
      expect(repository.record).toBeNull();
    });

    it("forbids a member from editing", async () => {
      role = "MEMBER";

      await expectRejection(
        update({ botName: "Scribe" }),
        ErrorCode.Forbidden,
        "organization_only_managers_can_update_organization"
      );
      expect(repository.record).toBeNull();
    });

    it("lets an owner edit", async () => {
      role = "OWNER";

      await expect(update({ botName: "Scribe" })).resolves.toMatchObject({
        botName: "Scribe",
        canEdit: true,
      });
    });

    it("trims and collapses whitespace in the name", async () => {
      await expect(update({ botName: "  Acme \n  Scribe\t " })).resolves.toMatchObject({
        botName: "Acme Scribe",
      });
      expect(repository.record?.botName).toBe("Acme Scribe");
    });

    it.each([["   "], [""], [null]])("clears the name for %j", async (value) => {
      await repository.upsertBotName(ORGANIZATION_ID, "Scribe");

      await expect(update({ botName: value })).resolves.toMatchObject({ botName: null });
      expect(repository.record?.botName).toBeNull();
    });

    it("accepts a 100-character name and rejects 101", async () => {
      await expect(update({ botName: "a".repeat(100) })).resolves.toMatchObject({ botName: "a".repeat(100) });

      await expectRejection(
        update({ botName: "b".repeat(101) }),
        ErrorCode.BadRequest,
        "notetaker_bot_name_too_long"
      );
      expect(repository.record?.botName).toBe("a".repeat(100));
    });

    it("leaves the name alone when only the image changes", async () => {
      await repository.upsertBotName(ORGANIZATION_ID, "Scribe");

      await expect(update({ botImage: PNG_DATA_URL })).resolves.toMatchObject({ botName: "Scribe" });
    });

    it("encodes an uploaded image into the bot frame and stores it", async () => {
      const dto = await update({ botImage: PNG_DATA_URL });

      expect(mocks.encodeJpegCover).toHaveBeenCalledWith({
        buffer: Buffer.from("png-bytes"),
        width: NOTETAKER_BOT_IMAGE_WIDTH,
        height: NOTETAKER_BOT_IMAGE_HEIGHT,
        maxBytes: NOTETAKER_BOT_IMAGE_MAX_BYTES,
      });
      expect(repository.image).toBe(ENCODED_JPEG.toString("base64"));
      expect(repository.record?.botImageUpdatedAt).toBeInstanceOf(Date);
      expect(dto.botImageDataUrl).toBe(`data:image/jpeg;base64,${ENCODED_JPEG.toString("base64")}`);
      expect(repository.imageReads).toBe(0);
    });

    it.each([
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/gif;base64,R0lGODlh",
      "data:image/png,rawbytes",
      "https://example.com/bot.png",
      "data:image/png;base64,",
    ])("rejects the data URL %j", async (botImage) => {
      await expectRejection(update({ botImage }), ErrorCode.BadRequest, "notetaker_bot_image_invalid");
      expect(mocks.encodeJpegCover).not.toHaveBeenCalled();
      expect(repository.record).toBeNull();
    });

    it("rejects an upload over 5MB before encoding", async () => {
      const botImage = `data:image/jpeg;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64")}`;

      await expectRejection(update({ botImage }), ErrorCode.BadRequest, "notetaker_bot_image_too_large");
      expect(mocks.encodeJpegCover).not.toHaveBeenCalled();
    });

    it("writes nothing when the encoder rejects the image", async () => {
      mocks.encodeJpegCover.mockRejectedValue(
        ErrorWithCode.Factory.BadRequest("notetaker_bot_image_invalid")
      );

      await expectRejection(
        update({ botName: "Scribe", botImage: PNG_DATA_URL }),
        ErrorCode.BadRequest,
        "notetaker_bot_image_invalid"
      );
      expect(repository.record).toBeNull();
    });

    it("removes the image", async () => {
      await repository.upsertBotImage(ORGANIZATION_ID, "c3RvcmVk", new Date());

      const dto = await update({ botImage: null });

      expect(dto.botImageDataUrl).toBeNull();
      expect(repository.image).toBeNull();
      expect(repository.record?.botImageUpdatedAt).toBeNull();
      expect(mocks.encodeJpegCover).not.toHaveBeenCalled();
    });

    it("returns the stored image when only the name changes", async () => {
      await repository.upsertBotImage(ORGANIZATION_ID, "c3RvcmVk", new Date());

      const dto = await update({ botName: "Scribe" });

      expect(dto).toMatchObject({ botName: "Scribe", botImageDataUrl: "data:image/jpeg;base64,c3RvcmVk" });
    });
  });
});
