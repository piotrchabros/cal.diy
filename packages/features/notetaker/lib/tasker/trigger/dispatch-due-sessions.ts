import { schedules } from "@trigger.dev/sdk";
import { notetakerTaskConfig } from "./config";

export const DISPATCH_DUE_SESSIONS_JOB_ID = "notetaker.dispatch-due-sessions";

export const dispatchDueSessions = schedules.task({
  id: DISPATCH_DUE_SESSIONS_JOB_ID,
  ...notetakerTaskConfig,
  cron: {
    pattern: "* * * * *",
    timezone: "UTC",
  },
  run: async () => {
    const { getNotetakerDispatchService } = await import(
      "@calcom/features/notetaker/di/NotetakerDispatchService.container"
    );

    const notetakerDispatchService = getNotetakerDispatchService();
    await notetakerDispatchService.dispatchDue();
  },
});
