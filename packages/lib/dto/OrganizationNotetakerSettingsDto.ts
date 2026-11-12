import { z } from "zod";

export const ORGANIZATION_NOTETAKER_BOT_NAME_MAX_LENGTH = 100;

export const OrganizationNotetakerSettingsDtoSchema = z.object({
  botName: z.string().nullable(),
  botImageDataUrl: z.string().nullable(),
  fallbackBotName: z.string().nullable(),
  canEdit: z.boolean(),
});

export type OrganizationNotetakerSettingsDto = z.infer<typeof OrganizationNotetakerSettingsDtoSchema>;
