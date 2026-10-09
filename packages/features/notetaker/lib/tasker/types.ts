import type { TriggerOptions } from "@trigger.dev/sdk";
import type { z } from "zod";
import type {
  notetakerFinalizeSessionSchema,
  notetakerGenerateSummarySchema,
  notetakerNotificationKindSchema,
  notetakerSendNotificationSchema,
} from "./trigger/schema";

export type NotetakerNotificationKind = z.infer<typeof notetakerNotificationKindSchema>;
export type NotetakerFinalizeSessionPayload = z.infer<typeof notetakerFinalizeSessionSchema>;
export type NotetakerGenerateSummaryPayload = z.infer<typeof notetakerGenerateSummarySchema>;
export type NotetakerSendNotificationPayload = z.infer<typeof notetakerSendNotificationSchema>;

export interface INotetakerTasker {
  finalizeSession(
    payload: NotetakerFinalizeSessionPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }>;
  generateSummary(
    payload: NotetakerGenerateSummaryPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }>;
  sendNotification(
    payload: NotetakerSendNotificationPayload,
    options?: TriggerOptions
  ): Promise<{ runId: string }>;
}

export type NotetakerTasks = {
  [K in keyof INotetakerTasker]: (payload: Parameters<INotetakerTasker[K]>[0]) => Promise<void>;
};
