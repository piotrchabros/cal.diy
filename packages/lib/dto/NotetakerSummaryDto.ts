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

export type NotetakerSummaryTopicCategoryDto = "PROBLEM" | "UPDATE" | "DECISION";

export const notetakerSummaryTopicCategorySchema: z.ZodType<NotetakerSummaryTopicCategoryDto> = z.enum([
  "PROBLEM",
  "UPDATE",
  "DECISION",
]);

export type NotetakerSummaryTopicDto = {
  title: string;
  category: NotetakerSummaryTopicCategoryDto | null;
  details: string[];
};

export const notetakerSummaryTopicSchema: z.ZodType<NotetakerSummaryTopicDto> = z.object({
  title: z.string(),
  category: notetakerSummaryTopicCategorySchema.nullable(),
  details: z.array(z.string()),
});

export type NotetakerSummaryFormatVersionDto = 1 | 2;

export type NotetakerSummaryDto = {
  formatVersion: NotetakerSummaryFormatVersionDto;
  status: NotetakerSummaryStatusDto;
  language: string | null;
  overview: string | null;
  keyPoints: string[];
  decisions: string[];
  topics: NotetakerSummaryTopicDto[];
  actionItems: { text: string; owner: string | null }[];
  generatedAt: string | null;
};

export const NotetakerSummaryDtoSchema: z.ZodType<NotetakerSummaryDto> = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  status: NotetakerSummaryStatusDtoSchema,
  language: z.string().nullable(),
  overview: z.string().nullable(),
  keyPoints: z.array(z.string()),
  decisions: z.array(z.string()),
  topics: z.array(notetakerSummaryTopicSchema),
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
