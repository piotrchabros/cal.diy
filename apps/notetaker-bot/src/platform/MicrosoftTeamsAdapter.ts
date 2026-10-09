// UNVERIFIED AGAINST THE REAL SERVICE (Microsoft Teams web): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/smoke-test-microsoft-teams.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
import type { RunnerConfig } from "../config";
import type { Logger } from "../logger";
import type { MeetingPageDriver, MeetingPageState } from "./browser/BrowserPlatformAdapter";
import { BrowserPlatformAdapter } from "./browser/BrowserPlatformAdapter";
import type { MeetingBrowserLauncher, MeetingPage } from "./browser/MeetingPage";
import type { PlatformName } from "./PlatformAdapter";

type JoinInput = { meetingUrl: string; displayName: string };
type DeviceControl = "microphone" | "camera";

const ENTRY_TIMEOUT_MS = 30000;
const PRE_JOIN_READY_TIMEOUT_MS = 5000;
const POST_JOIN_SETTLE_MS = 5000;
const CHAT_INPUT_TIMEOUT_MS = 3000;
const PEOPLE_PANEL_RETRY_MS = 30000;

// English locale, guest flow. A "." stands where an apostrophe would be, because Teams uses curly ones.
// The microphone and camera "on" selectors carry aria-checked="true" so that a click can only ever hit a control
// that is currently on: the page offers no attribute read to check it otherwise.
const S = {
  continueOnThisBrowser:
    '[data-tid="joinOnWeb"], button:has-text("Continue on this browser"), button:has-text("Join on the web instead")',
  continueWithoutDevices: 'button:has-text("Continue without audio or video")',
  preJoinNameInput: 'input[data-tid="prejoin-display-name-input"], input[placeholder="Type your name"]',
  preJoinMicrophoneOn: '[data-tid="toggle-mute"][aria-checked="true"]',
  preJoinMicrophoneOff: '[data-tid="toggle-mute"][aria-checked="false"]',
  preJoinCameraOn: '[data-tid="toggle-video"][aria-checked="true"]',
  preJoinCameraOff: '[data-tid="toggle-video"][aria-checked="false"]',
  preJoinJoinButton: 'button[data-tid="prejoin-join-button"], button:has-text("Join now")',
  waitingText:
    ':text-matches("someone (in the meeting|will) .*let you in|we.ll let people know you.re waiting|waiting (in the lobby|to be admitted)", "i")',
  deniedText:
    ':text-matches("denied access to (the|this) meeting|your request to join was declined|no one responded to your request", "i")',
  inMeetingMarker: '#hangup-button, button[data-tid="hangup-main-btn"]',
  removedText:
    ':text-matches("you.ve been removed from (the|this) meeting|you were removed from (the|this) meeting|removed you from the meeting", "i")',
  meetingEndedText: ':text-matches("(the|this) meeting (has )?ended|the meeting has been ended", "i")',
  invalidLinkText:
    ':text-matches("we couldn.t find (the|your|a) meeting|meeting not found|this meeting (link )?(is no longer available|doesn.t exist|has expired)|meeting (link|id) is(n.t| not)? ?(in)?valid", "i")',
  signInRequiredText:
    ':text-matches("sign in to join (this|the) meeting|only people (signed in|with an account)|anonymous (users|join).*(can.t|not allowed|disabled)", "i")',
  chatButton:
    'button#chat-button, button[data-tid="chat-button"], button[aria-label="Chat"], button[aria-label="Show conversation"]',
  chatInput:
    '[data-tid="ckeditor"][contenteditable="true"], div[role="textbox"][aria-label^="Type a message"]',
  chatSendButton:
    'button[data-tid="newMessageCommands-send"], button[data-tid="sendMessageCommands-send"], button[aria-label="Send"]',
  peopleButton:
    'button#roster-button, button[data-tid="roster-button"], button[aria-label="People"], button[aria-label="Show participants"]',
  participantCountBadge: '[data-tid="roster-button-tile"]',
  // The selector string is parsed as CSS before the pattern is compiled, hence the doubled backslashes.
  rosterHeading: String.raw`:text-matches("in this meeting \\(\\d+\\)", "i")`,
  activeSpeakerName:
    '[data-tid="voice-level-stream-outline"].vdi-frame-occlusion [data-tid*="display-name"], [data-stream-type]:has([data-tid="voice-level-stream-outline"].vdi-frame-occlusion) [data-tid*="display-name"]',
  leaveButton: '#hangup-button, button[data-tid="hangup-main-btn"]',
} as const satisfies Readonly<Record<string, string>>;

const cleanName = (text: string): string => text.replace(/\s+/g, " ").trim();

function firstNumber(text: string | null, pattern: RegExp): number | null {
  if (text === null) return null;
  const digits = pattern.exec(text)?.[1];
  if (digits === undefined) return null;
  return Number.parseInt(digits, 10);
}

export const MICROSOFT_TEAMS_SELECTORS = S;

export class MicrosoftTeamsPageDriver implements MeetingPageDriver {
  readonly platform: PlatformName = "MICROSOFT_TEAMS";

  private readonly logger: Logger;
  // Keyed by page so that the page opened by a reconnect starts fresh.
  private readonly peopleButtonClickedAtMs = new WeakMap<MeetingPage, number>();
  private readonly chatBusy = new WeakSet<MeetingPage>();

  constructor(deps: { logger: Logger }) {
    this.logger = deps.logger.child({ component: "MicrosoftTeamsPageDriver" });
  }

  async openAndAskToJoin(page: MeetingPage, input: JoinInput): Promise<void> {
    // No host or path check here: the controller already decided that this URL may be joined.
    await page.goto(input.meetingUrl);
    if (!(await this.reachPreJoin(page))) return;

    const ready = await this.waitForFirstVisible(
      page,
      [
        S.continueWithoutDevices,
        S.preJoinMicrophoneOn,
        S.preJoinMicrophoneOff,
        S.preJoinCameraOn,
        S.preJoinCameraOff,
      ],
      PRE_JOIN_READY_TIMEOUT_MS
    );
    if (ready === S.continueWithoutDevices) await page.click(S.continueWithoutDevices);

    await this.turnOff(page, "microphone", S.preJoinMicrophoneOn, S.preJoinMicrophoneOff);
    await this.turnOff(page, "camera", S.preJoinCameraOn, S.preJoinCameraOff);

    // Joining under whatever name the page would pick would hide who the notetaker is.
    if (!(await page.isVisible(S.preJoinNameInput))) {
      throw new Error("Microsoft Teams guest name field is missing");
    }
    await page.fill(S.preJoinNameInput, input.displayName);
    await page.click(S.preJoinJoinButton);

    // Whatever shows next, or nothing at all, is left to the state polling of the adapter.
    const after = await this.waitForFirstVisible(
      page,
      [S.continueWithoutDevices, S.waitingText, S.inMeetingMarker, S.deniedText],
      POST_JOIN_SETTLE_MS
    );
    if (after === S.continueWithoutDevices) await page.click(S.continueWithoutDevices);
  }

  // The lobby is believed to already show the call bar with its hang-up button, so the lobby text must override
  // the marker. Terminal texts count only once the call UI is gone, so that a chat message quoting one of them
  // cannot end the session.
  async readState(page: MeetingPage): Promise<MeetingPageState> {
    if (await page.isVisible(S.inMeetingMarker)) {
      if (await page.isVisible(S.waitingText)) return "WAITING";
      return "IN_MEETING";
    }
    if (await page.isVisible(S.removedText)) return "REMOVED";
    if (await page.isVisible(S.meetingEndedText)) return "ENDED";
    if (await page.isVisible(S.deniedText)) return "DENIED";
    if (await page.isVisible(S.invalidLinkText)) return "LINK_INVALID";
    // There is no closer state for a tenant that refuses guests: the link cannot be used by this bot either way.
    if (await page.isVisible(S.signInRequiredText)) return "LINK_INVALID";
    if (await page.isVisible(S.waitingText)) return "WAITING";
    if (await page.isVisible(S.preJoinJoinButton)) return "PRE_JOIN";
    if (await page.isVisible(S.continueOnThisBrowser)) return "PRE_JOIN";
    return "UNKNOWN";
  }

  async readParticipantCount(page: MeetingPage): Promise<number | null> {
    const fromBadge = firstNumber(await page.readText(S.participantCountBadge), /(\d+)/);
    if (fromBadge !== null) return fromBadge;
    const fromHeading = firstNumber(await page.readText(S.rosterHeading), /\((\d+)\)/);
    if (fromHeading !== null) return fromHeading;

    // The People and Chat panels share one side pane, so the button is left alone while a chat post is using
    // the pane, and a wrong guess about the panel being open must not toggle it on every poll.
    if (this.chatBusy.has(page)) return null;
    const clickedAtMs = this.peopleButtonClickedAtMs.get(page);
    const now = Date.now();
    if (clickedAtMs !== undefined && now - clickedAtMs <= PEOPLE_PANEL_RETRY_MS) return null;
    if (!(await page.isVisible(S.peopleButton))) return null;

    this.peopleButtonClickedAtMs.set(page, now);
    await page.click(S.peopleButton);
    return null;
  }

  async readActiveSpeakers(page: MeetingPage): Promise<{ participantId: string; name: string }[]> {
    const speakers = new Map<string, string>();
    for (const text of await page.readTexts(S.activeSpeakerName)) {
      const name = cleanName(text);
      if (name === "") continue;
      // The page offers text only, no attribute, so the displayed name is the only identity there is.
      const participantId = `name:${name.normalize("NFKC").toLowerCase()}`;
      if (!speakers.has(participantId)) speakers.set(participantId, name);
    }
    return Array.from(speakers, ([participantId, name]) => ({ participantId, name }));
  }

  async postChatMessage(page: MeetingPage, text: string): Promise<void> {
    this.chatBusy.add(page);
    try {
      // The button is clicked only while the input is hidden, so an open panel is never toggled shut.
      if (!(await page.isVisible(S.chatInput))) {
        if (!(await page.isVisible(S.chatButton))) throw new Error("Microsoft Teams chat is not available");
        await page.click(S.chatButton);
        if (!(await page.waitForVisible(S.chatInput, CHAT_INPUT_TIMEOUT_MS))) {
          throw new Error("Microsoft Teams chat input did not appear");
        }
      }
      await page.fill(S.chatInput, text);
      if (await page.isVisible(S.chatSendButton)) {
        await page.click(S.chatSendButton);
        return;
      }
      await page.pressKey("Enter");
    } finally {
      this.chatBusy.delete(page);
    }
  }

  async leave(page: MeetingPage): Promise<void> {
    if (!(await page.isVisible(S.leaveButton))) return;
    await page.click(S.leaveButton);
  }

  // False means the page shows that the link cannot be used. Nothing is clicked and nothing is thrown then: the
  // adapter reads the state right after this call and reports the unusable link itself, which keeps that
  // decision in one place.
  private async reachPreJoin(page: MeetingPage): Promise<boolean> {
    const first = await this.waitForFirstVisible(
      page,
      [S.continueOnThisBrowser, S.preJoinJoinButton, S.invalidLinkText, S.signInRequiredText],
      ENTRY_TIMEOUT_MS
    );
    if (first === S.preJoinJoinButton) return true;
    if (first === S.invalidLinkText || first === S.signInRequiredText) return false;
    if (first === null) throw new Error("Microsoft Teams did not show a join screen");

    await page.click(S.continueOnThisBrowser);
    const next = await this.waitForFirstVisible(
      page,
      [S.preJoinJoinButton, S.invalidLinkText, S.signInRequiredText],
      ENTRY_TIMEOUT_MS
    );
    if (next === null) throw new Error("Microsoft Teams did not show a join screen");
    return next === S.preJoinJoinButton;
  }

  private async turnOff(page: MeetingPage, control: DeviceControl, on: string, off: string): Promise<void> {
    if (await page.isVisible(on)) {
      await page.click(on);
      if (await page.isVisible(on)) throw new Error(`Microsoft Teams ${control} could not be turned off`);
      return;
    }
    if (await page.isVisible(off)) return;
    // Joining goes on: the browser context grants no media permission and has no device, so nothing can be sent.
    this.logger.warn("pre-join toggle not found", { control });
  }

  // Resolves with the first selector that became visible, in list order when several already are, or null when
  // none did in time. Every wait keeps its rejection handler after the result is known, because the losing
  // waits are still pending and reject when the page closes later.
  private waitForFirstVisible(
    page: MeetingPage,
    selectors: string[],
    timeoutMs: number
  ): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      let pending = selectors.length;
      if (pending === 0) {
        resolve(null);
        return;
      }
      for (const selector of selectors) {
        page.waitForVisible(selector, timeoutMs).then((visible) => {
          if (visible) {
            resolve(selector);
            return;
          }
          pending -= 1;
          if (pending === 0) resolve(null);
        }, reject);
      }
    });
  }
}

export class MicrosoftTeamsAdapter extends BrowserPlatformAdapter {
  constructor(deps: { browser: MeetingBrowserLauncher; chrome: RunnerConfig["chrome"]; logger: Logger }) {
    super({
      driver: new MicrosoftTeamsPageDriver({ logger: deps.logger }),
      browser: deps.browser,
      browserOptions: { channel: deps.chrome.channel, headless: deps.chrome.headless, storageState: null },
      logger: deps.logger,
    });
  }
}
