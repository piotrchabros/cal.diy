import { Tasker } from "@calcom/lib/tasker/Tasker";
import type { ILogger } from "@calcom/lib/tasker/types";
import type { TriggerOptions } from "@trigger.dev/sdk";
import type { NotetakerSyncTasker } from "./NotetakerSyncTasker";
import type { NotetakerTriggerTasker } from "./NotetakerTriggerTasker";
import type {
  INotetakerTasker,
  NotetakerFinalizeSessionPayload,
  NotetakerGenerateSummaryPayload,
  NotetakerSendNotificationPayload,
} from "./types";

export interface INotetakerTaskerDependencies {
  asyncTasker: NotetakerTriggerTasker;
  syncTasker: NotetakerSyncTasker;
  logger: ILogger;
}

export class NotetakerTasker extends Tasker<INotetakerTasker> implements INotetakerTasker {
  constructor(public readonly dependencies: INotetakerTaskerDependencies) {
    super(dependencies);
  }

  public async finalizeSession(
    payload: NotetakerFinalizeSessionPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    const { sessionId } = payload;
    let taskResponse: { runId: string } | null = null;

    try {
      taskResponse = await this.dispatch("finalizeSession", payload, options);

      this.logger.info("NotetakerTasker finalizeSession success:", taskResponse, { sessionId });
    } catch {
      taskResponse = { runId: "task-failed" };
      this.logger.error("NotetakerTasker finalizeSession failed", taskResponse, { sessionId });
    }

    return taskResponse;
  }

  public async generateSummary(
    payload: NotetakerGenerateSummaryPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    const { transcriptId } = payload;
    let taskResponse: { runId: string } | null = null;

    try {
      taskResponse = await this.dispatch("generateSummary", payload, options);

      this.logger.info("NotetakerTasker generateSummary success:", taskResponse, { transcriptId });
    } catch {
      taskResponse = { runId: "task-failed" };
      this.logger.error("NotetakerTasker generateSummary failed", taskResponse, { transcriptId });
    }

    return taskResponse;
  }

  public async sendNotification(
    payload: NotetakerSendNotificationPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }> {
    const { kind, bookingId, sessionId } = payload;
    let taskResponse: { runId: string } | null = null;

    try {
      taskResponse = await this.dispatch("sendNotification", payload, options);

      this.logger.info("NotetakerTasker sendNotification success:", taskResponse, {
        kind,
        bookingId,
        sessionId,
      });
    } catch {
      taskResponse = { runId: "task-failed" };
      this.logger.error("NotetakerTasker sendNotification failed", taskResponse, {
        kind,
        bookingId,
        sessionId,
      });
    }

    return taskResponse;
  }
}
