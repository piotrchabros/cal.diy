import { z } from "zod";

export const MoveUserResultDtoSchema = z.object({
  userId: z.number(),
  organizationId: z.number(),
  username: z.string().nullable(),
});

export const MoveTeamPreviewDtoSchema = z.object({
  membersOutsideTarget: z.array(
    z.object({
      userId: z.number(),
      name: z.string().nullable(),
      email: z.string(),
      usernameTaken: z.boolean(),
    })
  ),
  slugTaken: z.boolean(),
});

export const MoveTeamResultDtoSchema = z.object({
  teamId: z.number(),
  organizationId: z.number(),
  slug: z.string().nullable(),
});

export type MoveUserResultDto = z.infer<typeof MoveUserResultDtoSchema>;
export type MoveTeamPreviewDto = z.infer<typeof MoveTeamPreviewDtoSchema>;
export type MoveTeamResultDto = z.infer<typeof MoveTeamResultDtoSchema>;
