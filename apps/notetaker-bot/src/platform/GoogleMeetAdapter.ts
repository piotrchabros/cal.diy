// UNVERIFIED AGAINST THE REAL SERVICE (Google Meet in Chrome): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/smoke-test-google-meet.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
import type { RunnerConfig } from "../config";
import type { Logger } from "../logger";
import type { MeetingPageDriver, MeetingPageState } from "./browser/BrowserPlatformAdapter";
import { BrowserPlatformAdapter } from "./browser/BrowserPlatformAdapter";
import type { MeetingBrowserLauncher, MeetingPage } from "./browser/MeetingPage";
import type { PlatformName } from "./PlatformAdapter";

type GoogleConfig = RunnerConfig["google"];
type SelectorKey = keyof typeof GOOGLE_MEET_SELECTORS;
type JoinControl = "ask_to_join" | "join_now";
type SignInStep = "email" | "password" | "completion";

// The page wrapper acts on the first DOM match even when it is hidden, so a hidden duplicate ahead of the real
// control would be read or clicked instead. Every alternative is therefore limited to visible elements.
const visible = (...alternatives: string[]): string =>
  alternatives.map((alternative) => `${alternative}:visible`).join(", ");

const GUEST_NAME_INPUT = visible('input[aria-label="Your name"]');
const ASK_TO_JOIN_BUTTON = visible('button:has-text("Ask to join")');
const JOIN_NOW_BUTTON = visible('button:has-text("Join now")');
const LINK_INVALID_TEXT = visible(
  ':text("Check your meeting code")',
  ':text("Invalid video call name")',
  ':text("Make sure you entered the correct meeting code")'
);
const DENIED_TEXT = visible(
  ':text("denied your request to join")',
  ':text("No one responded to your request")',
  ':text-matches("You can.t join this", "i")'
);
const ENDED_TEXT = visible(
  ':text("The call ended")',
  ':text("call has ended")',
  ':text("meeting has ended")',
  ':text("You left the meeting")'
);
const REMOVED_TEXT = visible(
  ':text("been removed from the meeting")',
  ':text("removed you from the meeting")'
);

const DIALOG_KEYS: SelectorKey[] = ["dialogContinueWithoutDevices", "dialogGotIt", "dialogDismiss"];

// The in-call marker comes first: the text selectors match any element, including a chat message somebody
// typed, and a structural in-call control taking precedence keeps such text from reading as a removal or an end.
// The leave button is left out on purpose, because the waiting screen may show it too.
const STATE_ORDER: [SelectorKey, MeetingPageState][] = [
  ["inMeetingMarker", "IN_MEETING"],
  ["linkInvalidText", "LINK_INVALID"],
  ["removedText", "REMOVED"],
  ["deniedText", "DENIED"],
  ["endedText", "ENDED"],
  ["waitingText", "WAITING"],
  ["askToJoinButton", "PRE_JOIN"],
  ["joinNowButton", "PRE_JOIN"],
  ["guestNameInput", "PRE_JOIN"],
];

const VERDICT_STATES: MeetingPageState[] = ["LINK_INVALID", "DENIED", "ENDED", "REMOVED"];

const MISSING_CREDENTIALS_MESSAGE =
  "Google account join needs NOTETAKER_GOOGLE_STORAGE_STATE_B64 or both NOTETAKER_GOOGLE_ACCOUNT_EMAIL and NOTETAKER_GOOGLE_ACCOUNT_PASSWORD";

// Repeats what the configuration loader already does, so a guest cannot go in signed in whatever object a
// caller builds.
function storageStateFor(google: GoogleConfig): unknown | null {
  if (google.joinMode !== "account") return null;
  return google.storageState;
}

export const GOOGLE_SIGN_IN_URL =
  "https://accounts.google.com/ServiceLogin?hl=en&continue=https%3A%2F%2Fmeet.google.com%2F";
export const GOOGLE_MEET_JOIN_SCREEN_TIMEOUT_MS = 30000;
export const GOOGLE_MEET_CHAT_INPUT_TIMEOUT_MS = 5000;
export const GOOGLE_SIGN_IN_STEP_TIMEOUT_MS = 30000;

// There is deliberately no selector here for any control the bot is not allowed to use (FR-016): what has no
// selector cannot be clicked.
export const GOOGLE_MEET_SELECTORS = {
  dialogContinueWithoutDevices: visible('button:has-text("Continue without microphone and camera")'),
  dialogGotIt: visible('button:has-text("Got it")'),
  dialogDismiss: visible('button:has-text("Dismiss")'),
  turnOffMicrophone: visible(
    '[role="button"][aria-label*="Turn off microphone" i]',
    'button[aria-label*="Turn off microphone" i]'
  ),
  turnOffCamera: visible(
    '[role="button"][aria-label*="Turn off camera" i]',
    'button[aria-label*="Turn off camera" i]'
  ),
  guestNameInput: GUEST_NAME_INPUT,
  askToJoinButton: ASK_TO_JOIN_BUTTON,
  joinNowButton: JOIN_NOW_BUTTON,
  // The page offers no way to wait for any of several selectors, so "the page settled" is one composite.
  joinScreenOrVerdict: [
    GUEST_NAME_INPUT,
    ASK_TO_JOIN_BUTTON,
    JOIN_NOW_BUTTON,
    LINK_INVALID_TEXT,
    DENIED_TEXT,
    ENDED_TEXT,
    REMOVED_TEXT,
  ].join(", "),
  inMeetingMarker: visible(
    'button[aria-label*="Chat with everyone" i]',
    'button[aria-label*="Show everyone" i]',
    'button[aria-label="People"]'
  ),
  waitingText: visible(
    ':text("Asking to be let in")',
    ':text("when someone lets you in")',
    ':text("Asking to join")'
  ),
  deniedText: DENIED_TEXT,
  removedText: REMOVED_TEXT,
  endedText: ENDED_TEXT,
  linkInvalidText: LINK_INVALID_TEXT,
  participantCountBadge: visible(
    'button[aria-label*="Show everyone" i] ~ div',
    'button[aria-label="People"] ~ div'
  ),
  participantTile: visible("[data-participant-id]:not([data-participant-id] [data-participant-id])"),
  activeSpeakerName: visible('[data-participant-id]:has([aria-label*="speaking" i]) span.notranslate'),
  chatButton: visible('button[aria-label*="Chat with everyone" i]'),
  chatInput: visible('textarea[aria-label*="Send a message" i]'),
  chatSendButton: visible('button[aria-label*="Send a message" i]'),
  leaveCallButton: visible('button[aria-label*="Leave call" i]'),
  signInEmailInput: visible('input[type="email"]'),
  signInEmailNext: visible("#identifierNext button"),
  signInPasswordInput: visible('input[type="password"][name="Passwd"]'),
  signInPasswordNext: visible("#passwordNext button"),
  signedInMarker: visible('a[aria-label*="Google Account" i]'),
} as const satisfies Readonly<Record<string, string>>;

export class GoogleMeetPageDriver implements MeetingPageDriver {
  readonly platform: PlatformName = "GOOGLE_MEET";

  private readonly google: GoogleConfig;
  private readonly logger: Logger;
  // Sign-in and join run again on every reconnect; the warning must not.
  private displayNameWarningLogged = false;

  constructor(deps: { google: GoogleConfig; logger: Logger }) {
    this.google = deps.google;
    this.logger = deps.logger.child({ component: "GoogleMeetPageDriver" });
  }

  async signIn(page: MeetingPage): Promise<void> {
    const { joinMode, storageState, email, password } = this.google;
    if (joinMode === "guest") return;
    // The adapter already handed the stored session to the browser context.
    if (storageState !== null) return;
    if (email === null || password === null) throw new Error(MISSING_CREDENTIALS_MESSAGE);

    await page.goto(GOOGLE_SIGN_IN_URL);
    await this.awaitSignInStep(page, "signInEmailInput", "email");
    await page.fill(GOOGLE_MEET_SELECTORS.signInEmailInput, email);
    await page.click(GOOGLE_MEET_SELECTORS.signInEmailNext);
    await this.awaitSignInStep(page, "signInPasswordInput", "password");
    await page.fill(GOOGLE_MEET_SELECTORS.signInPasswordInput, password);
    await page.click(GOOGLE_MEET_SELECTORS.signInPasswordNext);
    await this.awaitSignInStep(page, "signedInMarker", "completion");
    this.logger.info("google sign-in completed");
  }

  async openAndAskToJoin(
    page: MeetingPage,
    input: { meetingUrl: string; displayName: string }
  ): Promise<void> {
    await page.goto(input.meetingUrl);
    const settled = await page.waitForVisible(
      GOOGLE_MEET_SELECTORS.joinScreenOrVerdict,
      GOOGLE_MEET_JOIN_SCREEN_TIMEOUT_MS
    );
    if (!settled) throw new Error("Google Meet did not show a join screen within the time limit");

    // A page that already gave its verdict is left untouched; the adapter's own read decides what it means.
    const state = await this.readState(page);
    if (VERDICT_STATES.includes(state)) return;

    await this.dismissDialogs(page);
    await this.turnOff(page, "turnOffMicrophone", "microphone");
    await this.turnOff(page, "turnOffCamera", "camera");
    await this.applyDisplayName(page, input.displayName);
    // A dialog can appear late and would intercept the join click.
    await this.dismissDialogs(page);
    const control = await this.clickJoinControl(page);
    this.logger.info("asked to join the meeting", { joinMode: this.google.joinMode, control });
  }

  async readState(page: MeetingPage): Promise<MeetingPageState> {
    for (const [key, state] of STATE_ORDER) {
      if (await page.isVisible(GOOGLE_MEET_SELECTORS[key])) return state;
    }
    return "UNKNOWN";
  }

  async readParticipantCount(page: MeetingPage): Promise<number | null> {
    const badge = await page.readText(GOOGLE_MEET_SELECTORS.participantCountBadge);
    const digits = badge?.match(/\d+/)?.[0];
    if (digits !== undefined) {
      const count = Number.parseInt(digits, 10);
      if (Number.isInteger(count) && count >= 1) return count;
    }

    const tiles = await page.readTexts(GOOGLE_MEET_SELECTORS.participantTile);
    if (tiles.length > 0) return tiles.length;
    return null;
  }

  // The id is derived from the displayed name because the page wrapper cannot read an attribute, so two
  // participants with the same display name count as one.
  async readActiveSpeakers(page: MeetingPage): Promise<{ participantId: string; name: string }[]> {
    const texts = await page.readTexts(GOOGLE_MEET_SELECTORS.activeSpeakerName);
    const names = new Set<string>();
    for (const text of texts) {
      const name = text.replace(/\s+/g, " ").trim();
      if (name !== "") names.add(name);
    }
    return Array.from(names, (name) => ({ participantId: `name:${name}`, name }));
  }

  async postChatMessage(page: MeetingPage, text: string): Promise<void> {
    // The chat button toggles the panel, so it is only clicked while the input is not showing.
    if (!(await page.isVisible(GOOGLE_MEET_SELECTORS.chatInput))) {
      await page.click(GOOGLE_MEET_SELECTORS.chatButton);
    }
    const shown = await page.waitForVisible(
      GOOGLE_MEET_SELECTORS.chatInput,
      GOOGLE_MEET_CHAT_INPUT_TIMEOUT_MS
    );
    if (!shown) throw new Error("Google Meet chat input did not appear; the notice was not posted");

    await page.fill(GOOGLE_MEET_SELECTORS.chatInput, text);
    // Sent with a click instead of a keypress: a wrong selector then fails loudly and the runner retries, where
    // a keypress on the wrong focus could resolve without the notice being posted.
    await page.click(GOOGLE_MEET_SELECTORS.chatSendButton);
    this.logger.info("notice sent to the meeting chat");
  }

  async leave(page: MeetingPage): Promise<void> {
    if (!(await page.isVisible(GOOGLE_MEET_SELECTORS.leaveCallButton))) return;
    await page.click(GOOGLE_MEET_SELECTORS.leaveCallButton);
  }

  private async awaitSignInStep(page: MeetingPage, key: SelectorKey, step: SignInStep): Promise<void> {
    const shown = await page.waitForVisible(GOOGLE_MEET_SELECTORS[key], GOOGLE_SIGN_IN_STEP_TIMEOUT_MS);
    if (!shown) throw new Error(`Google sign-in stalled at step ${step}`);
  }

  private async dismissDialogs(page: MeetingPage): Promise<void> {
    for (const key of DIALOG_KEYS) {
      if (!(await page.isVisible(GOOGLE_MEET_SELECTORS[key]))) continue;
      await page.click(GOOGLE_MEET_SELECTORS[key]);
      this.logger.debug("dismissed a dialog", { selectorKey: key });
    }
  }

  // The bot must not be heard or seen (FR-016), so a device that stays on stops the join.
  private async turnOff(
    page: MeetingPage,
    key: "turnOffMicrophone" | "turnOffCamera",
    device: "microphone" | "camera"
  ): Promise<void> {
    const selector = GOOGLE_MEET_SELECTORS[key];
    if (!(await page.isVisible(selector))) return;
    await page.click(selector);
    if (await page.isVisible(selector)) {
      throw new Error(`Google Meet ${device} could not be turned off; not joining`);
    }
  }

  private async applyDisplayName(page: MeetingPage, displayName: string): Promise<void> {
    const offersGuestName = await page.isVisible(GOOGLE_MEET_SELECTORS.guestNameInput);

    if (this.google.joinMode === "guest") {
      // Participants must be able to tell who the bot is (FR-012), so it does not join under another name.
      if (!offersGuestName) {
        throw new Error("Google Meet did not offer a guest name field; not joining without the display name");
      }
      await page.fill(GOOGLE_MEET_SELECTORS.guestNameInput, displayName);
      return;
    }

    // An expired stored session shows the guest screen; joining there would be an anonymous join.
    if (offersGuestName) {
      throw new Error("Google Meet shows a guest join screen although account join mode is configured");
    }
    if (this.displayNameWarningLogged) return;
    this.displayNameWarningLogged = true;
    this.logger.warn(
      "display name cannot be applied in account join mode; the meeting shows the account name",
      {
        joinMode: "account",
      }
    );
  }

  private async clickJoinControl(page: MeetingPage): Promise<JoinControl> {
    if (await page.isVisible(GOOGLE_MEET_SELECTORS.askToJoinButton)) {
      await page.click(GOOGLE_MEET_SELECTORS.askToJoinButton);
      return "ask_to_join";
    }
    if (await page.isVisible(GOOGLE_MEET_SELECTORS.joinNowButton)) {
      await page.click(GOOGLE_MEET_SELECTORS.joinNowButton);
      return "join_now";
    }
    throw new Error("Google Meet shows no control to ask to join");
  }
}

export class GoogleMeetAdapter extends BrowserPlatformAdapter {
  constructor(deps: {
    browser: MeetingBrowserLauncher;
    google: GoogleConfig;
    chrome: RunnerConfig["chrome"];
    logger: Logger;
  }) {
    super({
      driver: new GoogleMeetPageDriver({ google: deps.google, logger: deps.logger }),
      browser: deps.browser,
      browserOptions: {
        channel: deps.chrome.channel,
        headless: deps.chrome.headless,
        storageState: storageStateFor(deps.google),
      },
      logger: deps.logger,
    });
  }
}
