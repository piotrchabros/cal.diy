import { z } from "zod";

export type NotetakerSummaryStatusDto = "PENDING" | "READY" | "FAILED" | "NOT_ENOUGH_CONTENT";

export const NotetakerSummaryStatusDtoSchema: z.ZodType<NotetakerSummaryStatusDto> = z.enum([
  "PENDING",
  "READY",
  "FAILED",
  "NOT_ENOUGH_CONTENT",
]);

const actionItemSchema = z.object({
  text: z.string(),
  owner: z.string().nullable(),
});

export type NotetakerSummaryDto = {
  status: NotetakerSummaryStatusDto;
  language: string | null;
  overview: string | null;
  keyPoints: string[];
  decisions: string[];
  actionItems: { text: string; owner: string | null }[];
  generatedAt: string | null;
};

export const NotetakerSummaryDtoSchema: z.ZodType<NotetakerSummaryDto> = z.object({
  status: NotetakerSummaryStatusDtoSchema,
  language: z.string().nullable(),
  overview: z.string().nullable(),
  keyPoints: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(actionItemSchema),
  generatedAt: z.string().datetime().nullable(),
});

export const notetakerSummaryContentSchema = z.object({
  language: z.string(),
  overview: z.string(),
  keyPoints: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(actionItemSchema),
});

export type NotetakerSummaryContent = z.infer<typeof notetakerSummaryContentSchema>;
