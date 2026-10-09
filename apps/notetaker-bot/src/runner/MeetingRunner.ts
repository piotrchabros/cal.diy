import type {
  NotetakerBotEndReason,
  NotetakerBotJoinRequest,
  NotetakerBotPassage,
} from "@calcom/lib/notetaker/botContract";
import type { Pcm16Frame } from "../audio/AudioFrame";
import type { EventSenderStopCause, IEventSender, NotetakerBotEventDraft } from "../callback/EventSender";
import type { Logger } from "../logger";
import type { PlatformAdapter, PlatformEvent } from "../platform/PlatformAdapter";
import { PlatformLinkUnusableError } from "../platform/PlatformAdapter";
import type { ISpeakerAttributor } from "../speakers/SpeakerAttribution";
import type { SpeechToTextProvider, SttUtterance } from "../stt/SpeechToTextProvider";
import { AudioFramePump } from "./AudioFramePump";
import type { RunnerHandle, RunnerPhase, RunnerStatus } from "./launcher/MeetingRunnerLauncher";
import { PassageBuilder } from "./PassageBuilder";

// The sender splits above this; reaching it only triggers an early hand-over.
const EARLY_FLUSH_PASSAGE_COUNT = 50;

type Raced<T> = { outcome: "DONE"; value: T } | { outcome: "TIMEOUT" } | { outcome: "FAILED" };
type Race<T> = { result: Promise<Raced<T>>; cancel(): void };
type Timer = ReturnType<typeof setTimeout>;
type EndPosition = { interruptedAtMs?: number; durationMs?: number };

// The result never rejects, so an ending cannot be stalled or broken by a platform or provider call.
function raceWithTimeout<T>(work: () => Promise<T>, timeoutMs: number): Race<T> {
  let settle: (raced: Raced<T>) => void = () => {};
  const result = new Promise<Raced<T>>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => settle({ outcome: "TIMEOUT" }), timeoutMs);
  const finish = (raced: Raced<T>): void => {
    clearTimeout(timer);
    settle(raced);
  };

  try {
    work().then(
      (value) => finish({ outcome: "DONE", value }),
      () => finish({ outcome: "FAILED" })
    );
  } catch {
    finish({ outcome: "FAILED" });
  }

  return { result, cancel: () => finish({ outcome: "TIMEOUT" }) };
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "unknown";
}

export const HEARTBEAT_INTERVAL_MS = 30000;
export const PASSAGE_FLUSH_INTERVAL_MS = 5000;
export const NOTICE_RETRY_INTERVAL_MS = 5000;
export const NOTICE_DEADLINE_MS = 30000;
export const REJOIN_TIMEOUT_MS = 60000;
export const LEAVE_TIMEOUT_MS = 5000;
export const STT_FLUSH_TIMEOUT_MS = 3000;
export const ENDED_DELIVERY_TIMEOUT_MS = 300000;
// The sender has no acceptance callback, so a change of its last accepted sequence can only be seen by polling.
export const STATUS_POLL_INTERVAL_MS = 1000;

export type MeetingRunnerDeps = {
  request: NotetakerBotJoinRequest;
  platform: PlatformAdapter;
  stt: SpeechToTextProvider;
  attributor: ISpeakerAttributor;
  sender: IEventSender;
  logger: Logger;
  now?: () => number;
};

export type RunnerEndSummary = { endReason: NotetakerBotEndReason | null; passageCount: number };

export class MeetingRunner implements RunnerHandle {
  readonly done: Promise<RunnerEndSummary>;

  private readonly deps: MeetingRunnerDeps;
  private readonly logger: Logger;
  private readonly builder: PassageBuilder;
  private resolveDone: (summary: RunnerEndSummary) => void = () => {};

  private phase: RunnerPhase = "STARTING";
  private started = false;
  private ending = false;
  private completed = false;
  private senderStopped = false;
  private joinRequested = false;

  private startedAtMs = 0;
  private admittedAtMs: number | null = null;

  private participantCount = 0;
  private everSeenOthers = false;

  private noticeState: "IDLE" | "PENDING" | "POSTED" = "IDLE";
  private noticeInFlight = false;

  private readonly waiting: NotetakerBotPassage[] = [];
  private enqueuedPassageCount = 0;
  private utterancesClosed = false;

  private reconnectAttempted = false;
  private reconnecting = false;
  private cancelReconnectRace: (() => void) | null = null;

  private pump: AudioFramePump | null = null;

  private queuedTotal = 0;
  private drainedTotal = 0;
  private pendingSeen = 0;
  private heartbeatMark: number | null = null;

  private readonly listeners: ((status: RunnerStatus) => void)[] = [];
  private lastNotified: RunnerStatus | null = null;

  private heartbeatTimer: Timer | undefined;
  private statusPollTimer: Timer | undefined;
  private noShowTimer: Timer | undefined;
  private admissionTimer: Timer | undefined;
  private maxDurationTimer: Timer | undefined;
  private aloneTimer: Timer | undefined;
  private flushTimer: Timer | undefined;
  private noticeDeadlineTimer: Timer | undefined;
  private noticeRetryTimer: Timer | undefined;

  constructor(deps: MeetingRunnerDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ sessionId: deps.request.sessionId });
    this.builder = new PassageBuilder({ attributor: deps.attributor });
    this.done = new Promise<RunnerEndSummary>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  start(): void {
    if (this.started || this.ending) return;
    this.started = true;
    this.startedAtMs = this.now();
    this.notifyStatus();

    const { request } = this.deps;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.statusPollTimer = setInterval(() => this.notifyStatus(), STATUS_POLL_INTERVAL_MS);
    // The app may dispatch after the scheduled start (notetaker enabled late); a late runner gets a full
    // no-show period from its own start, otherwise it would leave before it could see who is in the meeting.
    const noShowDeadlineMs =
      Math.max(Date.parse(request.scheduledStartAt), this.startedAtMs) +
      request.limits.noShowTimeoutSeconds * 1000;
    this.noShowTimer = setTimeout(
      () => {
        if (this.everSeenOthers) return;
        this.end("MEETING_DID_NOT_START");
      },
      Math.max(0, noShowDeadlineMs - this.startedAtMs)
    );

    void this.join();
  }

  requestStop(): void {
    this.end("STOP_REQUESTED");
  }

  handleSenderStopped(cause: EventSenderStopCause): void {
    this.senderStopped = true;
    // A running ending sees the flag and skips session.ended by itself.
    if (this.ending) return;

    this.ending = true;
    this.logger.warn("event sender stopped, leaving the meeting", { cause, phase: this.phase });
    this.clearTimers();
    this.pump?.stop();
    this.utterancesClosed = true;
    this.waiting.length = 0;
    // The app no longer accepts events, so nothing waits for these: they only release the browser and the provider.
    raceWithTimeout(() => this.deps.platform.leave(), LEAVE_TIMEOUT_MS);
    raceWithTimeout(() => this.deps.stt.close(), STT_FLUSH_TIMEOUT_MS);
    this.complete(null);
  }

  getStatus(): RunnerStatus {
    return { phase: this.phase, lastEventSequence: this.deps.sender.lastAcceptedSequence };
  }

  onStatusChange(listener: (status: RunnerStatus) => void): void {
    this.listeners.push(listener);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // The transcript clock: 0 at admission, always an integer because the wire schema rejects fractions.
  private clockMs(): number {
    if (this.admittedAtMs === null) return 0;
    return Math.max(0, Math.round(this.now() - this.admittedAtMs));
  }

  private async join(): Promise<void> {
    const { request, platform } = this.deps;
    try {
      await platform.join(
        { meetingUrl: request.meetingUrl, displayName: request.displayName },
        {
          onEvent: (event) => this.onEvent(event),
          onAudioFrame: (frame) => this.onAudioFrame(frame),
        }
      );
    } catch (error) {
      this.logger.warn("join failed", { error: errorName(error) });
      this.end(error instanceof PlatformLinkUnusableError ? "MEETING_LINK_UNUSABLE" : "INTERRUPTED");
      return;
    }
    if (this.ending) return;
    this.markJoinRequested();
  }

  private markJoinRequested(): void {
    if (this.joinRequested) return;
    this.joinRequested = true;
    this.enqueue({ type: "session.join_requested", data: {} });
    this.setPhase("WAITING");
    this.admissionTimer = setTimeout(
      () => this.end("NOT_ADMITTED"),
      this.deps.request.limits.admissionTimeoutSeconds * 1000
    );
  }

  private onEvent(event: PlatformEvent): void {
    if (this.ending) return;
    // Adapters may emit before join() resolves, and session.join_requested must still come first.
    this.markJoinRequested();

    switch (event.type) {
      case "waiting":
        return;
      case "denied":
        if (this.phase === "IN_MEETING") return;
        this.end("NOT_ADMITTED");
        return;
      case "admitted":
        this.handleAdmitted();
        return;
      case "participant_count":
        this.handleParticipantCount(event.count);
        return;
      case "speaker":
        // Before admission there is no transcript clock to stamp the sample with.
        if (this.admittedAtMs === null) return;
        this.deps.attributor.recordSpeaker({
          atMs: this.clockMs(),
          participantId: event.participantId,
          name: event.name,
          speaking: event.speaking,
        });
        return;
      case "source_activity":
        if (this.admittedAtMs === null) return;
        this.deps.attributor.recordSourceActivity({
          atMs: this.clockMs(),
          sourceKey: event.sourceKey,
          level: event.level,
        });
        return;
      case "source_identity":
        this.deps.attributor.recordSourceIdentity({
          sourceKey: event.sourceKey,
          participantId: event.participantId,
          name: event.name,
        });
        return;
      case "meeting_ended":
        this.end("MEETING_ENDED");
        return;
      case "removed":
        this.end("REMOVED_BY_PARTICIPANT");
        return;
      case "connection_lost":
        this.handleConnectionLost();
        return;
    }
  }

  private handleAdmitted(): void {
    // A re-emit after a rejoin must not reset the transcript clock or post the notice again.
    if (this.phase === "IN_MEETING") return;

    const { limits } = this.deps.request;
    clearTimeout(this.admissionTimer);
    this.admittedAtMs = this.now();
    this.setPhase("IN_MEETING");
    this.enqueue({ type: "session.admitted", data: {} });

    this.maxDurationTimer = setTimeout(
      () => this.end("LENGTH_LIMIT_REACHED"),
      limits.maxDurationSeconds * 1000
    );
    this.flushTimer = setInterval(() => this.flushPassages(), PASSAGE_FLUSH_INTERVAL_MS);
    this.pump = new AudioFramePump({
      sink: (frame) => this.deps.stt.pushAudio(frame),
      nowMs: () => this.clockMs(),
    });
    void this.startStt();

    this.noticeState = "PENDING";
    // Armed before the first attempt so a post that never settles cannot outlive the deadline.
    this.noticeDeadlineTimer = setTimeout(() => this.handleNoticeDeadline(), NOTICE_DEADLINE_MS);
    void this.attemptNotice();
  }

  private handleParticipantCount(count: number): void {
    if (!Number.isFinite(count)) return;
    this.participantCount = Math.max(0, Math.trunc(count));

    if (this.participantCount > 1) {
      this.everSeenOthers = true;
      clearTimeout(this.aloneTimer);
      this.aloneTimer = undefined;
      clearTimeout(this.noShowTimer);
      return;
    }
    // A repeated count must not restart the timer, or a chatty adapter would keep the bot in an empty room.
    if (!this.everSeenOthers || this.aloneTimer !== undefined) return;
    this.aloneTimer = setTimeout(
      () => this.end("ALONE_TIMEOUT"),
      this.deps.request.limits.aloneTimeoutSeconds * 1000
    );
  }

  private handleConnectionLost(): void {
    if (this.phase !== "IN_MEETING") {
      this.end("INTERRUPTED");
      return;
    }
    // A further loss during the attempt is the same outage.
    if (this.reconnecting) return;

    const atMs = this.clockMs();
    if (this.reconnectAttempted) {
      this.end("INTERRUPTED", { interruptedAtMs: atMs, durationMs: atMs });
      return;
    }

    this.reconnectAttempted = true;
    this.reconnecting = true;
    this.enqueue({ type: "session.reconnecting", data: { atMs } });
    const race = raceWithTimeout(() => this.deps.platform.reconnect(), REJOIN_TIMEOUT_MS);
    this.cancelReconnectRace = race.cancel;
    void race.result.then((raced) => {
      this.cancelReconnectRace = null;
      if (this.ending) return;
      this.reconnecting = false;
      if (raced.outcome === "DONE" && raced.value) return;
      this.logger.warn("rejoin failed", { outcome: raced.outcome });
      this.end("INTERRUPTED", { interruptedAtMs: atMs, durationMs: atMs });
    });
  }

  private onAudioFrame(frame: Pcm16Frame): void {
    if (this.ending) return;
    this.pump?.push(frame);
  }

  private async startStt(): Promise<void> {
    try {
      await this.deps.stt.start({
        onUtterance: (utterance) => this.onUtterance(utterance),
        onError: (error) => this.handleSttFailure(error),
      });
    } catch (error) {
      this.handleSttFailure(error);
      return;
    }
    if (this.ending) return;
    // Started only now so the pump pads the connect time with silence and the provider's audio clock equals the transcript clock.
    this.pump?.start();
  }

  private handleSttFailure(error: unknown): void {
    if (this.ending) return;
    const atMs = this.clockMs();
    this.logger.error("speech-to-text failed", { error: errorName(error), atMs });
    this.end("INTERRUPTED", { interruptedAtMs: atMs, durationMs: atMs });
  }

  // Does not check `ending`: the provider emits its last utterances while it is being closed.
  private onUtterance(utterance: SttUtterance): void {
    if (this.utterancesClosed) return;
    this.waiting.push(...this.builder.add(utterance));
    if (this.waiting.length >= EARLY_FLUSH_PASSAGE_COUNT) this.flushPassages();
  }

  private flushPassages(): void {
    if (this.waiting.length === 0) return;
    // The in-meeting notice is mandatory (spec FR-013): no transcript.passages event is sent before the
    // notice has been posted and session.notice_posted has been sent, so nothing spoken leaves the
    // process before participants were told. Passages captured meanwhile are held in memory only; if
    // the notice cannot be posted within 30 s of admission they are discarded, the bot leaves and
    // session.ended carries INTERRUPTED (see handleNoticeDeadline).
    if (this.noticeState !== "POSTED") return;

    const passages = this.waiting.splice(0);
    this.enqueue({ type: "transcript.passages", data: { passages } });
    this.enqueuedPassageCount += passages.length;
  }

  private async attemptNotice(): Promise<void> {
    if (this.ending || this.noticeState !== "PENDING" || this.noticeInFlight) return;
    this.noticeInFlight = true;

    try {
      await this.deps.platform.postChatMessage(this.deps.request.noticeMessage);
    } catch (error) {
      this.noticeInFlight = false;
      if (this.ending || this.noticeState !== "PENDING") return;
      this.logger.warn("notice could not be posted", { error: errorName(error), atMs: this.clockMs() });
      // An attempt at the deadline itself would be pointless: the deadline handler ends the session then.
      if (this.clockMs() + NOTICE_RETRY_INTERVAL_MS >= NOTICE_DEADLINE_MS) return;
      this.noticeRetryTimer = setTimeout(() => void this.attemptNotice(), NOTICE_RETRY_INTERVAL_MS);
      return;
    }

    this.noticeInFlight = false;
    // A post that lands after the end began must not release anything.
    if (this.ending || this.noticeState !== "PENDING") return;
    this.noticeState = "POSTED";
    clearTimeout(this.noticeDeadlineTimer);
    clearTimeout(this.noticeRetryTimer);
    this.enqueue({ type: "session.notice_posted", data: {} });
    this.flushPassages();
  }

  private handleNoticeDeadline(): void {
    if (this.ending || this.noticeState === "POSTED") return;
    // The in-meeting notice is mandatory (spec FR-013): no transcript.passages event is sent before the
    // notice has been posted and session.notice_posted has been sent. It could not be posted within
    // 30 s of admission, so the passages held in memory meanwhile are discarded, the bot leaves and
    // session.ended carries INTERRUPTED. Nothing of the meeting was transcribed, hence position 0.
    this.logger.error("notice not posted before the deadline, leaving", {
      discardedPassages: this.waiting.length,
    });
    this.waiting.length = 0;
    this.end("INTERRUPTED", { interruptedAtMs: 0 });
  }

  private sendHeartbeat(): void {
    if (this.ending) return;
    this.observeQueue();
    // Only the previous heartbeat counts. Skipping on any pending event would drop every heartbeat while
    // passages are in flight (the 5 s flush and this tick are phase-locked) and trip the app's watchdog.
    if (this.heartbeatMark !== null && this.drainedTotal < this.heartbeatMark) return;
    this.enqueue({ type: "session.heartbeat", data: { participantCount: this.participantCount } });
    this.heartbeatMark = this.queuedTotal;
  }

  private observeQueue(): void {
    const pending = this.deps.sender.pendingCount;
    if (pending < this.pendingSeen) this.drainedTotal += this.pendingSeen - pending;
    this.pendingSeen = pending;
  }

  private enqueue(draft: NotetakerBotEventDraft): void {
    this.observeQueue();
    this.deps.sender.enqueue(draft);
    const pending = this.deps.sender.pendingCount;
    this.queuedTotal += Math.max(0, pending - this.pendingSeen);
    this.pendingSeen = pending;
  }

  private end(reason: NotetakerBotEndReason, position: EndPosition = {}): void {
    if (this.ending) return;
    this.ending = true;

    const admitted = this.admittedAtMs !== null;
    const durationMs = admitted ? (position.durationMs ?? this.clockMs()) : 0;
    const interruptedAtMs = admitted ? (position.interruptedAtMs ?? null) : null;
    this.logger.info("session ending", { reason, phase: this.phase, durationMs });

    this.clearTimers();
    this.pump?.stop();
    // Both start in this tick so the bot is on its way out of the meeting before anything is awaited.
    const leaving = raceWithTimeout(() => this.deps.platform.leave(), LEAVE_TIMEOUT_MS);
    const closing = raceWithTimeout(() => this.deps.stt.close(), STT_FLUSH_TIMEOUT_MS);
    void this.finish(reason, durationMs, interruptedAtMs, [leaving.result, closing.result]);
  }

  private async finish(
    reason: NotetakerBotEndReason,
    durationMs: number,
    interruptedAtMs: number | null,
    releases: Promise<unknown>[]
  ): Promise<void> {
    try {
      await Promise.all(releases);
      this.utterancesClosed = true;
      if (!this.senderStopped) {
        if (this.noticeState === "POSTED") {
          this.flushPassages();
        } else {
          if (this.waiting.length > 0) {
            this.logger.info("discarding passages held for the notice", { count: this.waiting.length });
          }
          this.waiting.length = 0;
        }
        this.enqueue({
          type: "session.ended",
          data: { endReason: reason, durationMs, interruptedAtMs, passageCount: this.enqueuedPassageCount },
        });
        await this.deps.sender.flush(ENDED_DELIVERY_TIMEOUT_MS);
      }
    } catch (error) {
      this.logger.error("ending failed", { error: errorName(error) });
    }
    this.complete(this.senderStopped ? null : reason);
  }

  private complete(endReason: NotetakerBotEndReason | null): void {
    if (this.completed) return;
    this.completed = true;
    this.setPhase("ENDED");
    this.notifyStatus();
    clearInterval(this.statusPollTimer);
    this.resolveDone({ endReason, passageCount: this.enqueuedPassageCount });
  }

  // The status poll keeps running: the sequence of session.ended is still to be reported while it is delivered.
  private clearTimers(): void {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.flushTimer);
    clearTimeout(this.noShowTimer);
    clearTimeout(this.admissionTimer);
    clearTimeout(this.maxDurationTimer);
    clearTimeout(this.aloneTimer);
    clearTimeout(this.noticeDeadlineTimer);
    clearTimeout(this.noticeRetryTimer);
    this.cancelReconnectRace?.();
  }

  private setPhase(phase: RunnerPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.notifyStatus();
  }

  private notifyStatus(): void {
    const status = this.getStatus();
    const last = this.lastNotified;
    if (last && last.phase === status.phase && last.lastEventSequence === status.lastEventSequence) return;
    this.lastNotified = status;

    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        this.logger.warn("status listener failed", { error: errorName(error) });
      }
    }
  }
}
