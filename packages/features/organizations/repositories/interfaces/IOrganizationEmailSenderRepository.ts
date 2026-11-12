export type OrganizationEmailSenderRecord = {
  organizationId: number;
  emailFromName: string | null;
  emailFromAddress: string | null;
  customDomain: string | null;
};

export interface IOrganizationEmailSenderRepository {
  findByOrganizationId(organizationId: number): Promise<OrganizationEmailSenderRecord | null>;
  update(
    organizationId: number,
    input: { emailFromName: string | null; emailFromAddress: string | null }
  ): Promise<OrganizationEmailSenderRecord | null>;
  findOrganizationIdByUserId(userId: number): Promise<number | null>;
  findOrganizationIdByUserEmail(email: string): Promise<number | null>;
  // The team's own id when it is the organization, otherwise its parent organization
  findOrganizationIdByTeamId(teamId: number): Promise<number | null>;
}
