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
    _payload: Parameters<INotetakerTasker["finalizeSession"]>[0],
    _options?: TriggerOptions
  ): Promise<{ runId: string }> {
    throw notWiredError("finalizeSession");
  }

  async generateSummary(
    _payload: Parameters<INotetakerTasker["generateSummary"]>[0],
    _options?: TriggerOptions
  ): Promise<{ runId: string }> {
    throw notWiredError("generateSummary");
  }

  async sendNotification(
    _payload: Parameters<INotetakerTasker["sendNotification"]>[0],
    _options?: TriggerOptions
  ): Promise<{ runId: string }> {
    throw notWiredError("sendNotification");
  }
}
