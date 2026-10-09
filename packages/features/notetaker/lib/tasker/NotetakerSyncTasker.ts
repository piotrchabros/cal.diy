import type { ITaskerDependencies } from "@calcom/lib/tasker/types";
import { nanoid } from "nanoid";
import type { NotetakerTaskService } from "./NotetakerTaskService";
import type { INotetakerTasker } from "./types";

export interface INotetakerSyncTaskerDependencies {
  notetakerTaskService: NotetakerTaskService;
}

export class NotetakerSyncTasker implements INotetakerTasker {
  constructor(public readonly dependencies: ITaskerDependencies & INotetakerSyncTaskerDependencies) {}

  async finalizeSession(
    payload: Parameters<INotetakerTasker["finalizeSession"]>[0]
  ): Promise<{ runId: string }> {
    const runId = `sync_${nanoid(10)}`;
    await this.dependencies.notetakerTaskService.finalizeSession(payload);
    return { runId };
  }

  async generateSummary(
    payload: Parameters<INotetakerTasker["generateSummary"]>[0]
  ): Promise<{ runId: string }> {
    const runId = `sync_${nanoid(10)}`;
    await this.dependencies.notetakerTaskService.generateSummary(payload);
    return { runId };
  }

  async sendNotification(
    payload: Parameters<INotetakerTasker["sendNotification"]>[0]
  ): Promise<{ runId: string }> {
    const runId = `sync_${nanoid(10)}`;
    await this.dependencies.notetakerTaskService.sendNotification(payload);
    return { runId };
  }
}
