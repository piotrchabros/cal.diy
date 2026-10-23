import { z } from "zod";

export const PublicTeamMemberEventTypeDtoSchema = z.object({
  id: z.number(),
  title: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  length: z.number(),
});

export const PublicTeamMemberDtoSchema = z.object({
  username: z.string(),
  name: z.string(),
  avatarUrl: z.string(),
  eventTypes: z.array(PublicTeamMemberEventTypeDtoSchema),
});

export type PublicTeamMemberEventTypeDto = z.infer<typeof PublicTeamMemberEventTypeDtoSchema>;
export type PublicTeamMemberDto = z.infer<typeof PublicTeamMemberDtoSchema>;
