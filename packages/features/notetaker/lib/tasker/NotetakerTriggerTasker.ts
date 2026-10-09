import type { ITaskerDependencies } from "@calcom/lib/tasker/types";
import type { TriggerOptions } from "@trigger.dev/sdk";
import type { INotetakerTasker } from "./types";

export class NotetakerTriggerTasker implements INotetakerTasker {
  constructor(public readonly dependencies: ITaskerDependencies) {}

  async finalizeSession(
    payload: Parameters<INotetakerTasker["finalizeSession"]>[0],
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    const { finalizeSession } = await import("./trigger/finalize-session");
    const handle = await finalizeSession.trigger(payload, options);
    return { runId: handle.id };
  }

  async generateSummary(
    payload: Parameters<INotetakerTasker["generateSummary"]>[0],
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    const { generateSummary } = await import("./trigger/generate-summary");
    const handle = await generateSummary.trigger(payload, options);
    return { runId: handle.id };
  }

  async sendNotification(
    payload: Parameters<INotetakerTasker["sendNotification"]>[0],
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    const { sendNotification } = await import("./trigger/send-notification");
    const handle = await sendNotification.trigger(payload, options);
    return { runId: handle.id };
  }
}
