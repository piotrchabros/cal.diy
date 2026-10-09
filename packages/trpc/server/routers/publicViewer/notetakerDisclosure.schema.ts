import { z } from "zod";

export const ZNotetakerDisclosureInputSchema = z.object({ eventTypeId: z.number().int() });

export type TNotetakerDisclosureInputSchema = z.infer<typeof ZNotetakerDisclosureInputSchema>;
