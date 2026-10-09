import { ErrorWithCode } from "@calcom/lib/errors";
import type { ITaskerDependencies } from "@calcom/lib/tasker/types";
import type { NotetakerTasks } from "./types";

function notWiredError(name: keyof NotetakerTasks): ErrorWithCode {
  return ErrorWithCode.Factory.InternalServerError(`Notetaker task "${name}" is not wired yet`);
}

export interface INotetakerTaskServiceDependencies {
  logger: ITaskerDependencies["logger"];
}

export class NotetakerTaskService implements NotetakerTasks {
  constructor(public readonly dependencies: INotetakerTaskServiceDependencies) {}

  async finalizeSession(_payload: Parameters<NotetakerTasks["finalizeSession"]>[0]): Promise<void> {
    throw notWiredError("finalizeSession");
  }

  async generateSummary(_payload: Parameters<NotetakerTasks["generateSummary"]>[0]): Promise<void> {
    throw notWiredError("generateSummary");
  }

  async sendNotification(_payload: Parameters<NotetakerTasks["sendNotification"]>[0]): Promise<void> {
    throw notWiredError("sendNotification");
  }
}
