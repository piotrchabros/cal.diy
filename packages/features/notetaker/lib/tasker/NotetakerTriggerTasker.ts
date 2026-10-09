import { ErrorWithCode } from "@calcom/lib/errors";
import type { ITaskerDependencies } from "@calcom/lib/tasker/types";
import type { TriggerOptions } from "@trigger.dev/sdk";
import type { INotetakerTasker } from "./types";

function notWiredError(name: keyof INotetakerTasker): ErrorWithCode {
  return ErrorWithCode.Factory.InternalServerError(`Notetaker task "${name}" is not wired yet`);
}

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
    _payload: Parameters<INotetakerTasker["generateSummary"]>[0],
    _options?: TriggerOptions
  ): Promise<{ runId: string }> {
    throw notWiredError("generateSummary");
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
