import { z } from "zod";

export const TeamWithOrganizationDtoSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string().nullable(),
  memberCount: z.number(),
  organization: z.object({ id: z.number(), name: z.string() }).nullable(),
});

export const TeamWithOrganizationListDtoSchema = z.object({
  rows: z.array(TeamWithOrganizationDtoSchema),
  nextCursor: z.number().optional(),
  meta: z.object({ totalRowCount: z.number() }),
});

export type TeamWithOrganizationDto = z.infer<typeof TeamWithOrganizationDtoSchema>;
export type TeamWithOrganizationListDto = z.infer<typeof TeamWithOrganizationListDtoSchema>;
