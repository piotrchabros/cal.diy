import { schemaTask, type TaskWithSchema } from "@trigger.dev/sdk";
import type { z } from "zod";
import { notetakerTaskConfig } from "./config";
import { notetakerSendNotificationSchema } from "./schema";

export const SEND_NOTIFICATION_JOB_ID = "notetaker.send-notification";

export const sendNotification: TaskWithSchema<
  typeof SEND_NOTIFICATION_JOB_ID,
  typeof notetakerSendNotificationSchema
> = schemaTask({
  id: SEND_NOTIFICATION_JOB_ID,
  ...notetakerTaskConfig,
  schema: notetakerSendNotificationSchema,
  run: async (payload: z.infer<typeof notetakerSendNotificationSchema>) => {
    const { getNotetakerTaskService } = await import(
      "@calcom/features/notetaker/di/tasker/NotetakerTaskService.container"
    );

    const notetakerTaskService = getNotetakerTaskService();
    await notetakerTaskService.sendNotification(payload);
  },
});
