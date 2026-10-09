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

  // The services are resolved through their containers at call time: the finalize service depends on the
  // tasker, whose DI module loads this class, so a static import or a DI dependency would form a cycle.
  async finalizeSession(payload: Parameters<NotetakerTasks["finalizeSession"]>[0]): Promise<void> {
    const { getNotetakerFinalizeService } = await import(
      "@calcom/features/notetaker/di/NotetakerFinalizeService.container"
    );
    await getNotetakerFinalizeService().finalize(payload);
  }

  async generateSummary(_payload: Parameters<NotetakerTasks["generateSummary"]>[0]): Promise<void> {
    throw notWiredError("generateSummary");
  }

  async sendNotification(payload: Parameters<NotetakerTasks["sendNotification"]>[0]): Promise<void> {
    const { getNotetakerNotificationService } = await import(
      "@calcom/features/notetaker/di/NotetakerNotificationService.container"
    );
    await getNotetakerNotificationService().send(payload);
  }
}
