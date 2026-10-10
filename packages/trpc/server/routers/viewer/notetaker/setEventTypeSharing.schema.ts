import { z } from "zod";

export const ZSetEventTypeSharingInputSchema = z.object({
  eventTypeId: z.number().int(),
  mode: z.enum(["HOSTS_ONLY", "TEAM", "SELECTED_PEOPLE"]),
  userIds: z
    .array(z.number().int().positive())
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, { message: "userIds must be distinct" })
    .optional(),
});
export type TSetEventTypeSharingInputSchema = z.infer<typeof ZSetEventTypeSharingInputSchema>;
