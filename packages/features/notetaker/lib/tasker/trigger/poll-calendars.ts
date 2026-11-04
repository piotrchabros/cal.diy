import { schedules } from "@trigger.dev/sdk";
import { notetakerTaskConfig } from "./config";

export const POLL_CALENDARS_JOB_ID = "notetaker.poll-calendars";

export const pollCalendars = schedules.task({
  id: POLL_CALENDARS_JOB_ID,
  ...notetakerTaskConfig,
  cron: {
    pattern: "*/5 * * * *",
    timezone: "UTC",
  },
  run: async () => {
    const { getNotetakerCalendarAutoJoinService } = await import(
      "@calcom/features/notetaker/di/NotetakerCalendarAutoJoinService.container"
    );

    const notetakerCalendarAutoJoinService = getNotetakerCalendarAutoJoinService();
    await notetakerCalendarAutoJoinService.pollDue();
  },
});
