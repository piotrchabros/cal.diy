import type { Pcm16Frame } from "../audio/AudioFrame";
import type { PlatformAdapter, PlatformEvent, PlatformHandlers, PlatformName } from "./PlatformAdapter";

type FakePlatformAdapterOptions = {
  platform?: PlatformName;
  joinError?: Error;
  postChatError?: Error;
  reconnectResult?: boolean;
  reconnectDelayMs?: number;
  leaveDelayMs?: number;
  onJoined?: () => void;
};

type PendingReconnect = { timer: ReturnType<typeof setTimeout>; resolve: (admitted: boolean) => void };

export class FakePlatformAdapter implements PlatformAdapter {
  readonly platform: PlatformName;
  readonly joinCalls: { meetingUrl: string; displayName: string }[] = [];
  readonly chatMessages: string[] = [];
  reconnectCalls = 0;
  leaveCalls = 0;

  private handlers: PlatformHandlers | null = null;
  private left = false;
  private postChatError: Error | null;
  private leavePromise: Promise<void> | null = null;
  private pendingReconnects: PendingReconnect[] = [];
  private readonly joinError: Error | undefined;
  private readonly reconnectResult: boolean;
  private readonly reconnectDelayMs: number;
  private readonly leaveDelayMs: number;
  private readonly onJoined: (() => void) | undefined;

  constructor(options: FakePlatformAdapterOptions = {}) {
    this.platform = options.platform ?? "GOOGLE_MEET";
    this.joinError = options.joinError;
    this.postChatError = options.postChatError ?? null;
    this.reconnectResult = options.reconnectResult ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 0;
    this.leaveDelayMs = options.leaveDelayMs ?? 0;
    this.onJoined = options.onJoined;
  }

  async join(input: { meetingUrl: string; displayName: string }, handlers: PlatformHandlers): Promise<void> {
    this.joinCalls.push({ meetingUrl: input.meetingUrl, displayName: input.displayName });
    if (this.left) throw new Error("FakePlatformAdapter: join called after leave");
    if (this.handlers) throw new Error("FakePlatformAdapter: join called twice");
    if (this.joinError) throw this.joinError;

    this.handlers = handlers;
    // Synchronous so a consumer can schedule its script and emit from inside it.
    this.onJoined?.();
  }

  async postChatMessage(text: string): Promise<void> {
    if (!this.handlers) throw new Error("FakePlatformAdapter: postChatMessage called while not in a meeting");
    if (this.postChatError) throw this.postChatError;
    this.chatMessages.push(text);
  }

  // Not async: wrapping the stored promise would add ticks and a caller awaiting once could miss an immediate result.
  reconnect(): Promise<boolean> {
    this.reconnectCalls += 1;
    if (!this.handlers) return Promise.resolve(false);
    if (this.reconnectDelayMs <= 0) return Promise.resolve(this.reconnectResult);

    return new Promise<boolean>((resolve) => {
      const pending: PendingReconnect = {
        timer: setTimeout(() => {
          this.pendingReconnects = this.pendingReconnects.filter((entry) => entry !== pending);
          resolve(this.reconnectResult);
        }, this.reconnectDelayMs),
        resolve,
      };
      this.pendingReconnects.push(pending);
    });
  }

  leave(): Promise<void> {
    this.leaveCalls += 1;
    if (this.leavePromise) return this.leavePromise;

    this.left = true;
    this.handlers = null;
    for (const pending of this.pendingReconnects) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingReconnects = [];

    if (this.leaveDelayMs <= 0) {
      this.leavePromise = Promise.resolve();
      return this.leavePromise;
    }

    this.leavePromise = new Promise<void>((resolve) => {
      setTimeout(resolve, this.leaveDelayMs);
    });
    return this.leavePromise;
  }

  emit(event: PlatformEvent): void {
    this.requireHandlers("emit").onEvent(event);
  }

  emitAudio(frame: Pcm16Frame): void {
    this.requireHandlers("emitAudio").onAudioFrame(frame);
  }

  setPostChatError(error: Error | null): void {
    this.postChatError = error;
  }

  private requireHandlers(method: "emit" | "emitAudio"): PlatformHandlers {
    if (this.handlers) return this.handlers;
    if (this.left) throw new Error(`FakePlatformAdapter: ${method} called after leave`);
    throw new Error(`FakePlatformAdapter: ${method} called before a successful join`);
  }
}
