import type { NotetakerBotJoinRequest, NotetakerBotStateDto } from "@calcom/lib/notetaker/botContract";

export type RunnerPhase = NotetakerBotStateDto["phase"];

export type RunnerStatus = { phase: RunnerPhase; lastEventSequence: number };

export type RunnerHandle = {
  start(): void;
  requestStop(): void;
  getStatus(): RunnerStatus;
  readonly done: Promise<unknown>;
};

export class RunnerLaunchError extends Error {
  readonly kind: "AT_CAPACITY" | "FAILED";

  constructor(kind: "AT_CAPACITY" | "FAILED", message: string) {
    super(message);
    this.name = "RunnerLaunchError";
    this.kind = kind;
  }
}

export interface MeetingRunnerLauncher {
  /** Idempotent on sessionId; resolves when the runner process or container has been started. */
  launch(request: NotetakerBotJoinRequest): Promise<{ externalRef: string }>;
  /** Resolves when the stop was delivered; an unknown or ended session resolves. */
  stop(sessionId: string): Promise<void>;
  getStatus(sessionId: string): Promise<RunnerStatus | null>;
  /** Counts runners whose phase is not ENDED. */
  countActive(): Promise<number>;
  /** Stops every runner; called on controller SIGTERM. */
  shutdown(): Promise<void>;
}
