import { schemaTask, type TaskWithSchema } from "@trigger.dev/sdk";
import type { z } from "zod";
import { notetakerTaskConfig } from "./config";
import { notetakerFinalizeSessionSchema } from "./schema";

export const FINALIZE_SESSION_JOB_ID = "notetaker.finalize-session";

export const finalizeSession: TaskWithSchema<
  typeof FINALIZE_SESSION_JOB_ID,
  typeof notetakerFinalizeSessionSchema
> = schemaTask({
  id: FINALIZE_SESSION_JOB_ID,
  ...notetakerTaskConfig,
  schema: notetakerFinalizeSessionSchema,
  run: async (payload: z.infer<typeof notetakerFinalizeSessionSchema>) => {
    const { getNotetakerTaskService } = await import(
      "@calcom/features/notetaker/di/tasker/NotetakerTaskService.container"
    );

    const notetakerTaskService = getNotetakerTaskService();
    await notetakerTaskService.finalizeSession(payload);
  },
});
