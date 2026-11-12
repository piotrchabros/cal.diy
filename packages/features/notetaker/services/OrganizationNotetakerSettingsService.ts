import { ORGANIZATION_ERRORS } from "@calcom/features/organizations/lib/organizationErrors";
import type { OrganizationMembershipService } from "@calcom/features/organizations/services/OrganizationMembershipService";
import type { OrganizationNotetakerSettingsDto } from "@calcom/lib/dto/OrganizationNotetakerSettingsDto";
import { ORGANIZATION_NOTETAKER_BOT_NAME_MAX_LENGTH } from "@calcom/lib/dto/OrganizationNotetakerSettingsDto";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import { encodeJpegCover } from "@calcom/lib/server/imageUtils";
import {
  NOTETAKER_BOT_IMAGE_HEIGHT,
  NOTETAKER_BOT_IMAGE_MAX_BYTES,
  NOTETAKER_BOT_IMAGE_WIDTH,
} from "../lib/botImage";
import type { NotetakerConfig } from "../lib/config";
import type {
  IOrganizationNotetakerSettingsRepository,
  OrganizationNotetakerSettingsRecord,
} from "../repositories/interfaces/IOrganizationNotetakerSettingsRepository";

const log = logger.getSubLogger({ prefix: ["[OrganizationNotetakerSettingsService]"] });

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const UPLOAD_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp);base64,/;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface IOrganizationNotetakerSettingsServiceDeps {
  settingsRepository: IOrganizationNotetakerSettingsRepository;
  organizationMembershipService: Pick<OrganizationMembershipService, "getRole">;
  config: Pick<NotetakerConfig, "botName">;
}

export class OrganizationNotetakerSettingsService {
  constructor(private readonly deps: IOrganizationNotetakerSettingsServiceDeps) {}

  async get(params: {
    organizationId: number;
    viewerUserId: number;
  }): Promise<OrganizationNotetakerSettingsDto> {
    const { organizationId, viewerUserId } = params;
    const role = await this.deps.organizationMembershipService.getRole(viewerUserId, organizationId);
    if (role === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);

    const record = await this.deps.settingsRepository.findByOrganizationId(organizationId);
    return this.toDto(organizationId, record, role !== "MEMBER");
  }

  async update(params: {
    organizationId: number;
    actorUserId: number;
    botName?: string | null;
    botImage?: string | null;
  }): Promise<OrganizationNotetakerSettingsDto> {
    const { organizationId, actorUserId } = params;
    const { settingsRepository, organizationMembershipService } = this.deps;

    const role = await organizationMembershipService.getRole(actorUserId, organizationId);
    if (role === null) throw ErrorWithCode.Factory.NotFound(ORGANIZATION_ERRORS.notFound);
    if (role === "MEMBER") {
      throw ErrorWithCode.Factory.Forbidden(ORGANIZATION_ERRORS.onlyManagersCanUpdateOrganization);
    }

    // Validate both fields before writing either, so a bad image never leaves a half-applied update
    const botName = params.botName === undefined ? undefined : this.parseBotName(params.botName);
    const botImageJpeg =
      params.botImage === undefined || params.botImage === null
        ? params.botImage
        : await this.encodeBotImage(params.botImage);

    let record: OrganizationNotetakerSettingsRecord | null = null;
    if (botName !== undefined) record = await settingsRepository.upsertBotName(organizationId, botName);
    if (botImageJpeg !== undefined) {
      record = await settingsRepository.upsertBotImage(organizationId, botImageJpeg, new Date());
    }
    record ??= await settingsRepository.findByOrganizationId(organizationId);

    log.info("organization.notetakerSettings.update", {
      action: "organization.notetakerSettings.update",
      actorUserId,
      organizationId,
    });

    return this.toDto(organizationId, record, true, botImageJpeg);
  }

  private parseBotName(raw: string | null): string | null {
    if (raw === null) return null;
    const botName = raw.replace(/\s+/g, " ").trim();
    if (!botName) return null;
    if (botName.length > ORGANIZATION_NOTETAKER_BOT_NAME_MAX_LENGTH) {
      throw ErrorWithCode.Factory.BadRequest("notetaker_bot_name_too_long");
    }
    return botName;
  }

  private async encodeBotImage(dataUrl: string): Promise<string> {
    const prefix = dataUrl.match(UPLOAD_DATA_URL_PATTERN);
    if (!prefix) throw ErrorWithCode.Factory.BadRequest("notetaker_bot_image_invalid");

    const buffer = Buffer.from(dataUrl.slice(prefix[0].length), "base64");
    if (buffer.length === 0) throw ErrorWithCode.Factory.BadRequest("notetaker_bot_image_invalid");
    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw ErrorWithCode.Factory.BadRequest("notetaker_bot_image_too_large");
    }

    const jpeg = await encodeJpegCover({
      buffer,
      width: NOTETAKER_BOT_IMAGE_WIDTH,
      height: NOTETAKER_BOT_IMAGE_HEIGHT,
      maxBytes: NOTETAKER_BOT_IMAGE_MAX_BYTES,
    });
    return jpeg.toString("base64");
  }

  /** knownImage skips re-reading the blob right after it was written (null = just removed). */
  private async toDto(
    organizationId: number,
    record: OrganizationNotetakerSettingsRecord | null,
    canEdit: boolean,
    knownImage?: string | null
  ): Promise<OrganizationNotetakerSettingsDto> {
    let botImage: string | null = null;
    if (knownImage !== undefined) {
      botImage = knownImage;
    } else if (record?.botImageUpdatedAt) {
      botImage = await this.deps.settingsRepository.findBotImageByOrganizationId(organizationId);
    }

    return {
      botName: record?.botName ?? null,
      botImageDataUrl: botImage ? `${JPEG_DATA_URL_PREFIX}${botImage}` : null,
      fallbackBotName: this.deps.config.botName,
      canEdit,
    };
  }
}
