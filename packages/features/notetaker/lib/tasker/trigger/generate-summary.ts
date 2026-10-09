import { schemaTask, type TaskWithSchema } from "@trigger.dev/sdk";
import type { z } from "zod";
import { notetakerTaskConfig } from "./config";
import { notetakerGenerateSummarySchema } from "./schema";

export const GENERATE_SUMMARY_JOB_ID = "notetaker.generate-summary";

export const generateSummary: TaskWithSchema<
  typeof GENERATE_SUMMARY_JOB_ID,
  typeof notetakerGenerateSummarySchema
> = schemaTask({
  id: GENERATE_SUMMARY_JOB_ID,
  ...notetakerTaskConfig,
  schema: notetakerGenerateSummarySchema,
  run: async (payload: z.infer<typeof notetakerGenerateSummarySchema>) => {
    const { getNotetakerTaskService } = await import(
      "@calcom/features/notetaker/di/tasker/NotetakerTaskService.container"
    );

    const notetakerTaskService = getNotetakerTaskService();
    await notetakerTaskService.generateSummary(payload);
  },
});
