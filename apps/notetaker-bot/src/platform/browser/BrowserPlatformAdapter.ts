// UNVERIFIED AGAINST THE REAL SERVICE (Google Meet in Chrome): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/smoke-test-google-meet.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
import {
  AUDIO_FRAME_BINDING,
  buildAudioCaptureInitScript,
  decodeAudioFramePayload,
  decodeSourceActivityPayload,
  SOURCE_ACTIVITY_BINDING,
} from "../../audio/captureScript";
import type { Logger } from "../../logger";
import type { PlatformAdapter, PlatformEvent, PlatformHandlers, PlatformName } from "../PlatformAdapter";
import { PlatformLinkUnusableError } from "../PlatformAdapter";
import type { MeetingBrowserLauncher, MeetingBrowserOptions, MeetingPage } from "./MeetingPage";

type JoinInput = { meetingUrl: string; displayName: string };

type PageSession = {
  page: MeetingPage;
  // Events and audio flow only once join or reconnect succeeded on this page.
  live: boolean;
  stopped: boolean;
  closed: boolean;
  // The next poll tick, or the reconnect wait.
  timer: ReturnType<typeof setTimeout> | null;
  wake: (() => void) | null;
};

type LossCause = "page_closed" | "read_failed" | "unknown_state";

type BrowserPlatformAdapterDeps = {
  driver: MeetingPageDriver;
  browser: MeetingBrowserLauncher;
  browserOptions: MeetingBrowserOptions;
  logger: Logger;
  pollIntervalMs?: number;
  unknownStateGraceMs?: number;
};

const CLOSED_WHILE_JOINING_MESSAGE = "Meeting page closed while joining";

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_UNKNOWN_STATE_GRACE_MS = 15000;
export const DRIVER_LEAVE_TIMEOUT_MS = 3000;

export type MeetingPageState =
  | "PRE_JOIN"
  | "WAITING"
  | "IN_MEETING"
  | "DENIED"
  | "REMOVED"
  | "ENDED"
  | "LINK_INVALID"
  | "UNKNOWN";

export interface MeetingPageDriver {
  readonly platform: PlatformName;
  signIn?(page: MeetingPage): Promise<void>;
  openAndAskToJoin(page: MeetingPage, input: { meetingUrl: string; displayName: string }): Promise<void>;
  readState(page: MeetingPage): Promise<MeetingPageState>;
  readParticipantCount(page: MeetingPage): Promise<number | null>;
  readActiveSpeakers(page: MeetingPage): Promise<{ participantId: string; name: string }[]>;
  postChatMessage(page: MeetingPage, text: string): Promise<void>;
  leave(page: MeetingPage): Promise<void>;
}

export class BrowserPlatformAdapter implements PlatformAdapter {
  readonly platform: PlatformName;

  private readonly driver: MeetingPageDriver;
  private readonly browser: MeetingBrowserLauncher;
  private readonly browserOptions: MeetingBrowserOptions;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly unknownStateGraceMs: number;

  private handlers: PlatformHandlers | null = null;
  private input: JoinInput | null = null;
  private session: PageSession | null = null;
  private left = false;
  private leavePromise: Promise<void> | null = null;
  private reconnecting = false;
  // These four outlive a page: a reconnect must not repeat a state event or an unchanged count.
  private admitted = false;
  private waitingEmitted = false;
  private lastCount: number | null = null;
  private unknownSinceMs: number | null = null;
  private readonly activeSpeakers = new Map<string, string>();
  private audioHandlerFailureLogged = false;

  constructor(deps: BrowserPlatformAdapterDeps) {
    this.driver = deps.driver;
    this.browser = deps.browser;
    this.browserOptions = deps.browserOptions;
    this.platform = deps.driver.platform;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.unknownStateGraceMs = deps.unknownStateGraceMs ?? DEFAULT_UNKNOWN_STATE_GRACE_MS;
    this.logger = deps.logger.child({ component: "BrowserPlatformAdapter", platform: this.platform });
  }

  async join(input: JoinInput, handlers: PlatformHandlers): Promise<void> {
    if (this.left) throw new Error("BrowserPlatformAdapter: join called after leave");
    if (this.handlers) throw new Error("BrowserPlatformAdapter: join called twice");
    this.handlers = handlers;
    this.input = input;

    let session: PageSession;
    try {
      session = await this.openSession(input);
    } catch (error) {
      this.resetJoin();
      throw error;
    }

    // The state is only checked here, not applied: no event may reach the runner before join resolves.
    let state: MeetingPageState;
    try {
      state = await this.driver.readState(session.page);
    } catch (error) {
      await this.abandonSession(session);
      this.resetJoin();
      throw error;
    }
    if (this.left || session.closed) {
      await this.abandonSession(session);
      this.resetJoin();
      throw new Error(CLOSED_WHILE_JOINING_MESSAGE);
    }
    if (state === "LINK_INVALID") {
      await this.abandonSession(session);
      this.resetJoin();
      throw new PlatformLinkUnusableError("The meeting page reports that this link cannot be used");
    }

    session.live = true;
    this.scheduleTick(session);
  }

  async postChatMessage(text: string): Promise<void> {
    const session = this.session;
    if (!session || !this.isCurrent(session)) {
      throw new Error("BrowserPlatformAdapter: postChatMessage called while not in a meeting");
    }
    await this.driver.postChatMessage(session.page, text);
  }

  async reconnect(): Promise<boolean> {
    const input = this.input;
    if (this.left || !this.handlers || !input || this.reconnecting) return false;
    this.reconnecting = true;
    try {
      const old = this.session;
      if (old) {
        old.stopped = true;
        this.clearTimer(old);
        await this.closeQuietly(old.page);
      }
      if (this.left) return false;

      let session: PageSession;
      try {
        session = await this.openSession(input);
      } catch (error) {
        this.logger.warn("reconnect could not open the meeting page", { errorName: errorName(error) });
        return false;
      }

      if (!(await this.waitUntilAdmittedAgain(session))) {
        await this.abandonSession(session);
        return false;
      }

      this.admitted = true;
      this.unknownSinceMs = null;
      session.live = true;
      this.scheduleTick(session);
      return true;
    } finally {
      this.reconnecting = false;
    }
  }

  // Not async: every call must hand back the same promise object.
  leave(): Promise<void> {
    if (this.leavePromise) return this.leavePromise;

    this.left = true;
    this.handlers = null;
    const session = this.session;
    this.session = null;
    if (session) {
      session.stopped = true;
      this.clearTimer(session);
      session.wake?.();
    }
    this.leavePromise = this.releaseSession(session);
    return this.leavePromise;
  }

  private isCurrent(session: PageSession): boolean {
    return this.session === session && session.live && !session.stopped && !this.left;
  }

  private resetJoin(): void {
    this.handlers = null;
    this.input = null;
  }

  private clearTimer(session: PageSession): void {
    if (session.timer === null) return;
    clearTimeout(session.timer);
    session.timer = null;
  }

  private async closeQuietly(page: MeetingPage): Promise<void> {
    try {
      await page.close();
    } catch (error) {
      this.logger.warn("closing the meeting page failed", { errorName: errorName(error) });
    }
  }

  private async abandonSession(session: PageSession): Promise<void> {
    session.stopped = true;
    this.clearTimer(session);
    await this.closeQuietly(session.page);
    if (this.session === session) this.session = null;
  }

  private emit(event: PlatformEvent): void {
    const handlers = this.handlers;
    if (!handlers) return;
    // Swallowed so that a throwing handler inside a tick is not mistaken for a failed page read.
    try {
      handlers.onEvent(event);
    } catch (error) {
      this.logger.warn("event handler threw", { eventType: event.type, errorName: errorName(error) });
    }
  }

  private async openSession(input: JoinInput): Promise<PageSession> {
    const page = await this.browser.open(this.browserOptions);
    const session: PageSession = {
      page,
      live: false,
      stopped: false,
      closed: false,
      timer: null,
      wake: null,
    };
    if (this.left) {
      session.stopped = true;
      await this.closeQuietly(page);
      throw new Error("Meeting browser was released while the page was opening");
    }
    this.session = session;

    try {
      page.onClosed(() => this.handlePageClosed(session));
      await page.addInitScript(buildAudioCaptureInitScript());
      await page.exposeBinding(AUDIO_FRAME_BINDING, (payload) => this.handleAudioFrame(session, payload));
      await page.exposeBinding(SOURCE_ACTIVITY_BINDING, (payload) =>
        this.handleSourceActivity(session, payload)
      );
      await this.driver.signIn?.(page);
      await this.driver.openAndAskToJoin(page, input);
      if (this.left || session.closed) throw new Error(CLOSED_WHILE_JOINING_MESSAGE);
    } catch (error) {
      await this.abandonSession(session);
      // Rethrown untouched: a driver may itself report an unusable link from openAndAskToJoin.
      throw error;
    }
    return session;
  }

  private handleAudioFrame(session: PageSession, payload: unknown): void {
    if (!this.isCurrent(session)) return;
    const frame = decodeAudioFramePayload(payload);
    if (!frame) return;
    try {
      this.handlers?.onAudioFrame(frame);
    } catch (error) {
      // Frames arrive several times a second, so a failing handler is reported once only.
      if (this.audioHandlerFailureLogged) return;
      this.audioHandlerFailureLogged = true;
      this.logger.warn("audio frame handler threw", { errorName: errorName(error) });
    }
  }

  private handleSourceActivity(session: PageSession, payload: unknown): void {
    if (!this.isCurrent(session)) return;
    const entries = decodeSourceActivityPayload(payload);
    if (!entries) return;
    for (const entry of entries) {
      this.emit({ type: "source_activity", sourceKey: entry.sourceKey, level: entry.level });
    }
  }

  private handlePageClosed(session: PageSession): void {
    session.closed = true;
    session.wake?.();
    if (this.isCurrent(session)) this.lose(session, "page_closed");
  }

  // Self-rescheduling rather than an interval: the next timer is armed only when a tick completed, so two ticks
  // cannot overlap on a slow page.
  private scheduleTick(session: PageSession): void {
    session.timer = setTimeout(() => {
      session.timer = null;
      this.tick(session).catch((error: unknown) => {
        this.logger.error("poll tick failed", { errorName: errorName(error) });
      });
    }, this.pollIntervalMs);
  }

  // A thrown read is a loss; a null result means the tick must stop, either for that or because the session was
  // stopped or replaced while the read was pending.
  private async readOrLose<T>(session: PageSession, read: () => Promise<T>): Promise<{ value: T } | null> {
    let value: T;
    try {
      value = await read();
    } catch (error) {
      if (this.isCurrent(session)) {
        this.logger.warn("meeting page read failed", { errorName: errorName(error) });
        this.lose(session, "read_failed");
      }
      return null;
    }
    return this.isCurrent(session) ? { value } : null;
  }

  private async tick(session: PageSession): Promise<void> {
    if (!this.isCurrent(session)) return;
    const page = session.page;

    const stateRead = await this.readOrLose(session, () => this.driver.readState(page));
    if (!stateRead) return;
    const state = this.normaliseState(stateRead.value);

    if (state === "UNKNOWN") {
      const now = Date.now();
      this.unknownSinceMs ??= now;
      if (now - this.unknownSinceMs > this.unknownStateGraceMs) {
        this.lose(session, "unknown_state");
        return;
      }
      this.scheduleTick(session);
      return;
    }
    this.unknownSinceMs = null;

    if (state === "REMOVED") return this.finish(session, { type: "removed" });
    if (state === "ENDED") return this.finish(session, { type: "meeting_ended" });
    if (state === "DENIED" || state === "LINK_INVALID") return this.finish(session, { type: "denied" });

    if (state === "WAITING" && !this.waitingEmitted) {
      this.waitingEmitted = true;
      this.emit({ type: "waiting" });
    }
    if (state === "IN_MEETING") {
      if (!this.admitted) {
        this.admitted = true;
        this.emit({ type: "admitted" });
      }
      const countRead = await this.readOrLose(session, () => this.driver.readParticipantCount(page));
      if (!countRead) return;
      this.applyParticipantCount(countRead.value);

      const speakersRead = await this.readOrLose(session, () => this.driver.readActiveSpeakers(page));
      if (!speakersRead) return;
      this.applySpeakers(speakersRead.value);
    }

    // A handler called above may have left the meeting.
    if (this.isCurrent(session)) this.scheduleTick(session);
  }

  // Once admitted, a pre-admission screen can only be a page that is mid-transition or broken, so it runs on the
  // grace clock instead of producing a state event.
  private normaliseState(state: MeetingPageState): MeetingPageState {
    if (!this.admitted) return state;
    if (state === "IN_MEETING" || state === "REMOVED" || state === "ENDED") return state;
    return "UNKNOWN";
  }

  private applyParticipantCount(count: number | null): void {
    if (count === null || !Number.isInteger(count) || count < 0) return;
    if (count === this.lastCount) return;
    this.lastCount = count;
    this.emit({ type: "participant_count", count });
  }

  private applySpeakers(speakers: { participantId: string; name: string }[]): void {
    const next = new Map<string, string>();
    for (const speaker of speakers) {
      if (speaker.participantId === "" || next.has(speaker.participantId)) continue;
      next.set(speaker.participantId, speaker.name);
    }

    const stopped = Array.from(this.activeSpeakers).filter(([participantId]) => !next.has(participantId));
    const started = Array.from(next).filter(([participantId]) => !this.activeSpeakers.has(participantId));
    for (const [participantId, name] of stopped) {
      this.activeSpeakers.delete(participantId);
      this.emit({ type: "speaker", participantId, name, speaking: false });
    }
    for (const [participantId, name] of started) {
      this.activeSpeakers.set(participantId, name);
      this.emit({ type: "speaker", participantId, name, speaking: true });
    }
  }

  // The attributor does not expire an open speaking interval, so every one is closed before polling ends.
  private closeOpenSpeakers(): void {
    const open = Array.from(this.activeSpeakers);
    this.activeSpeakers.clear();
    for (const [participantId, name] of open) {
      this.emit({ type: "speaker", participantId, name, speaking: false });
    }
  }

  // The page stays open after a terminal state or a loss: leave or reconnect closes it.
  private finish(session: PageSession, event: PlatformEvent): void {
    session.stopped = true;
    this.clearTimer(session);
    this.closeOpenSpeakers();
    this.emit(event);
  }

  private lose(session: PageSession, cause: LossCause): void {
    if (session.stopped) return;
    session.stopped = true;
    this.clearTimer(session);
    this.closeOpenSpeakers();
    this.emit({ type: "connection_lost" });
    this.logger.warn("meeting connection lost", { cause });
  }

  private waitForNextRead(session: PageSession): Promise<void> {
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        this.clearTimer(session);
        session.wake = null;
        resolve();
      };
      session.wake = settle;
      session.timer = setTimeout(settle, this.pollIntervalMs);
    });
  }

  // No timeout of its own: the runner races reconnect and then calls leave, which wakes this loop.
  private async waitUntilAdmittedAgain(session: PageSession): Promise<boolean> {
    const isAbandoned = (): boolean => this.left || session.closed || session.stopped;
    let unknownSinceMs: number | null = null;

    while (!isAbandoned()) {
      let state: MeetingPageState;
      try {
        state = await this.driver.readState(session.page);
      } catch (error) {
        this.logger.warn("meeting page read failed during reconnect", { errorName: errorName(error) });
        return false;
      }
      // Checked again so that a leave during the read does not arm a wait nobody would wake.
      if (isAbandoned()) return false;

      if (state === "IN_MEETING") return true;
      if (state === "DENIED" || state === "REMOVED" || state === "ENDED" || state === "LINK_INVALID") {
        return false;
      }
      if (state === "UNKNOWN") {
        const now = Date.now();
        unknownSinceMs ??= now;
        if (now - unknownSinceMs > this.unknownStateGraceMs) return false;
      } else {
        unknownSinceMs = null;
      }
      await this.waitForNextRead(session);
    }
    return false;
  }

  private async releaseSession(session: PageSession | null): Promise<void> {
    if (!session) return;
    if (!session.closed) await this.leaveThroughDriver(session.page);
    await this.closeQuietly(session.page);
  }

  // Bounded because a hung page must not keep the browser, and with it the bot, alive.
  private async leaveThroughDriver(page: MeetingPage): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), DRIVER_LEAVE_TIMEOUT_MS);
    });
    try {
      const didTimeOut = await Promise.race([this.driver.leave(page).then(() => false), timedOut]);
      if (didTimeOut) this.logger.warn("leaving through the meeting page timed out");
    } catch (error) {
      this.logger.warn("leaving through the meeting page failed", { errorName: errorName(error) });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
