import { z } from "zod";

export const ZNotetakerContactEmailsSchema = z
  .array(z.string().trim().toLowerCase().email().max(320))
  .max(20);

export const ZSetMeetingContactsInputSchema = z.object({
  bookingUid: z.string().min(1),
  emails: ZNotetakerContactEmailsSchema,
});

export type TSetMeetingContactsInputSchema = z.infer<typeof ZSetMeetingContactsInputSchema>;
