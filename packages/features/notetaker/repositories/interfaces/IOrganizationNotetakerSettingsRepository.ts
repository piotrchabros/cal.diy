export type OrganizationNotetakerSettingsRecord = {
  organizationId: number;
  botName: string | null;
  botImageUpdatedAt: Date | null;
};

export interface IOrganizationNotetakerSettingsRepository {
  findByOrganizationId(organizationId: number): Promise<OrganizationNotetakerSettingsRecord | null>;
  /** Settings of the organization the user belongs to (users.organizationId). */
  findByUserId(userId: number): Promise<OrganizationNotetakerSettingsRecord | null>;
  /** Base64 JPEG without prefix, or null. The only method that reads the blob. */
  findBotImageByOrganizationId(organizationId: number): Promise<string | null>;
  upsertBotName(organizationId: number, botName: string | null): Promise<OrganizationNotetakerSettingsRecord>;
  upsertBotImage(
    organizationId: number,
    botImageJpeg: string | null,
    at: Date
  ): Promise<OrganizationNotetakerSettingsRecord>;
}
