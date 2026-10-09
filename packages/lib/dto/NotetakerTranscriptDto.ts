import { z } from "zod";

export type NotetakerTranscriptCompletenessDto = "COMPLETE" | "PARTIAL" | "TRUNCATED";

export const NotetakerTranscriptCompletenessDtoSchema: z.ZodType<NotetakerTranscriptCompletenessDto> = z.enum(
  ["COMPLETE", "PARTIAL", "TRUNCATED"]
);

export type NotetakerPassageDto = {
  index: number;
  speakerName: string | null;
  unknownSpeakerNumber: number | null;
  startMs: number;
  endMs: number;
  text: string;
  language: string | null;
};

export const NotetakerPassageDtoSchema: z.ZodType<NotetakerPassageDto> = z
  .object({
    index: z.number().int().nonnegative(),
    speakerName: z.string().nullable(),
    unknownSpeakerNumber: z.number().int().nullable(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    text: z.string(),
    language: z.string().nullable(),
  })
  .refine((passage) => (passage.speakerName === null) !== (passage.unknownSpeakerNumber === null), {
    message: "Exactly one of speakerName and unknownSpeakerNumber must be set",
    path: ["speakerName"],
  });

export type NotetakerTranscriptDto = {
  id: string;
  language: string | null;
  completeness: NotetakerTranscriptCompletenessDto;
  durationMs: number;
  passageCount: number;
};

export const NotetakerTranscriptDtoSchema: z.ZodType<NotetakerTranscriptDto> = z.object({
  id: z.string(),
  language: z.string().nullable(),
  completeness: NotetakerTranscriptCompletenessDtoSchema,
  durationMs: z.number().int().nonnegative(),
  passageCount: z.number().int().nonnegative(),
});
