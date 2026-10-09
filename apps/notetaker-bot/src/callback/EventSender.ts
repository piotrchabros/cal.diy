import { randomUUID } from "node:crypto";
import type { NotetakerBotEvent } from "@calcom/lib/notetaker/botContract";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  notetakerBotEventSchema,
  signNotetakerPayload,
} from "@calcom/lib/notetaker/botContract";
import type { Logger } from "../logger";

// Mirrors the per-event passage limit of notetakerBotEventSchema, which the contract does not export.
const MAX_PASSAGES_PER_EVENT = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY = { baseDelayMs: 1_000, maxDelayMs: 30_000 };
const DEFAULT_MAX_CONSECUTIVE_UNAUTHORIZED = 3;

type QueuedEvent = { sequence: number; type: NotetakerBotEvent["type"]; body: string };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

export type NotetakerBotEventDraft = NotetakerBotEvent extends infer E
  ? E extends { type: infer T; data: infer D }
    ? { type: T; data: D }
    : never
  : never;

export type EventSenderStopCause = "GONE" | "UNAUTHORIZED";

export interface IEventSender {
  enqueue(draft: NotetakerBotEventDraft): void;
  flush(timeoutMs?: number): Promise<void>;
  stop(): void;
  readonly lastAcceptedSequence: number;
  readonly pendingCount: number;
  readonly isStopped: boolean;
}

export type EventSenderDeps = {
  sessionId: string;
  callbackUrl: string;
  secret: string;
  onStopped: (cause: EventSenderStopCause) => void;
  logger: Logger;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  requestTimeoutMs?: number;
  retry?: { baseDelayMs: number; maxDelayMs: number };
  maxConsecutiveUnauthorized?: number;
};

export class EventSender implements IEventSender {
  private readonly queue: QueuedEvent[] = [];
  private readonly waiters: (() => void)[] = [];
  private readonly logger: Logger;
  private nextSequence = 1;
  private lastAccepted = 0;
  private stopped = false;
  private draining = false;
  private consecutiveUnauthorized = 0;
  private inFlight: AbortController | null = null;

  constructor(private readonly deps: EventSenderDeps) {
    this.logger = deps.logger.child({ sessionId: deps.sessionId });
  }

  get lastAcceptedSequence(): number {
    return this.lastAccepted;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  enqueue(draft: NotetakerBotEventDraft): void {
    if (this.stopped) return;

    for (const chunk of this.split(draft)) {
      const event = {
        eventId: randomUUID(),
        sessionId: this.deps.sessionId,
        sequence: this.nextSequence,
        occurredAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
        ...chunk,
      };
      const parsed = notetakerBotEventSchema.safeParse(event);
      if (!parsed.success) {
        // Issue paths and codes only: zod messages and values could carry transcript text.
        const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join(",");
        this.logger.error("Dropped an event the callback contract refuses", {
          type: chunk.type,
          sequence: this.nextSequence,
          issues,
        });
        continue;
      }
      this.queue.push({ sequence: this.nextSequence, type: chunk.type, body: JSON.stringify(event) });
      this.nextSequence++;
    }

    void this.drain();
  }

  flush(timeoutMs?: number): Promise<void> {
    if (this.stopped || this.queue.length === 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      this.waiters.push(waiter);
      if (timeoutMs === undefined) return;
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve();
      }, timeoutMs);
    });
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.inFlight?.abort();
    this.notifyWaiters();
  }

  private split(draft: NotetakerBotEventDraft): NotetakerBotEventDraft[] {
    if (draft.type !== "transcript.passages") return [draft];

    const chunks: NotetakerBotEventDraft[] = [];
    for (let start = 0; start < draft.data.passages.length; start += MAX_PASSAGES_PER_EVENT) {
      chunks.push({
        ...draft,
        data: { ...draft.data, passages: draft.data.passages.slice(start, start + MAX_PASSAGES_PER_EVENT) },
      });
    }
    return chunks;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped) {
        const head = this.queue[0];
        if (!head) break;
        await this.deliver(head);
      }
    } catch (error) {
      this.logger.error("Event delivery loop failed", { error: errorName(error) });
    } finally {
      this.draining = false;
      this.notifyWaiters();
    }
  }

  private async deliver(item: QueuedEvent): Promise<void> {
    const retry = this.deps.retry ?? DEFAULT_RETRY;
    const sleep = this.deps.sleep ?? defaultSleep;
    let attempt = 0;

    while (!this.stopped) {
      const status = await this.attempt(item);
      if (this.stopped) return;

      if (status !== null && status !== 401) this.consecutiveUnauthorized = 0;

      if (status !== null && status >= 200 && status < 300) {
        this.lastAccepted = item.sequence;
        this.queue.shift();
        return;
      }
      if (status === 410) {
        this.stopFor("GONE");
        return;
      }
      if (status === 400 || status === 401) {
        this.logger.error("Callback refused an event", { type: item.type, sequence: item.sequence, status });
        this.queue.shift();
        if (status === 401) {
          this.consecutiveUnauthorized++;
          const limit = this.deps.maxConsecutiveUnauthorized ?? DEFAULT_MAX_CONSECUTIVE_UNAUTHORIZED;
          if (this.consecutiveUnauthorized >= limit) this.stopFor("UNAUTHORIZED");
        }
        return;
      }

      const delayMs = Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
      attempt++;
      this.logger.warn("Callback did not accept an event, retrying", {
        type: item.type,
        sequence: item.sequence,
        status,
        attempt,
        delayMs,
      });
      await sleep(delayMs);
    }
  }

  private async attempt(item: QueuedEvent): Promise<number | null> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );
    this.inFlight = controller;
    try {
      // A retry after a long outage must not carry a stale timestamp, so sign again every time.
      const timestamp = Math.floor((this.deps.now ?? Date.now)() / 1000);
      const signature = signNotetakerPayload({
        secret: this.deps.secret,
        timestamp,
        rawBody: item.body,
      });
      const fetchFn = this.deps.fetchFn ?? globalThis.fetch;
      const response = await fetchFn(this.deps.callbackUrl, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        body: item.body,
        headers: {
          "content-type": "application/json",
          [NOTETAKER_TIMESTAMP_HEADER]: String(timestamp),
          [NOTETAKER_SIGNATURE_HEADER]: signature,
        },
      });
      void response.body?.cancel().catch(() => undefined);
      return response.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      this.inFlight = null;
    }
  }

  private stopFor(cause: EventSenderStopCause): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    this.notifyWaiters();
    try {
      this.deps.onStopped(cause);
    } catch (error) {
      this.logger.error("onStopped handler failed", { error: errorName(error) });
    }
  }

  private notifyWaiters(): void {
    if (!this.stopped && this.queue.length > 0) return;
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}
