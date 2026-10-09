// UNVERIFIED AGAINST THE REAL SERVICE (Google sign-in and Google Meet in Chrome; this script was not run by its
// authors): written from documentation and memory; only scripts/captureGoogleStatePlan.ts is unit-tested. Run it as
// docs/smoke-test-google-meet.md section 8 says, record the result in docs/verification-status.md, then remove this notice.
//
// Usage: yarn workspace @calcom/notetaker-bot capture-google-state [--out <file>]
// Opens a headed Chrome for a person to sign in to the bot's Google account, then prints the value for
// NOTETAKER_GOOGLE_STORAGE_STATE_B64 on standard output (or writes the raw state to --out with mode 0600).
import { existsSync, writeFileSync } from "node:fs";
import process from "node:process";
import { createInterface, type Interface } from "node:readline";
import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import { GOOGLE_MEET_SELECTORS, GOOGLE_SIGN_IN_URL } from "../src/platform/GoogleMeetAdapter";
import {
  type AbortCause,
  abortMessage,
  CAPTURE_GOOGLE_STATE_USAGE,
  capturePreflightRefusal,
  decideSignedIn,
  describeLaunchFailure,
  encodeStorageState,
  exitCodeForAbort,
  GOOGLE_ACCOUNT_PAGE_URL,
  GOOGLE_MEET_HOME_URL,
  hasGoogleSessionCookie,
  MEET_SIGN_IN_PROMPT_SELECTOR,
  outFileInstruction,
  outFileWriteFailureMessage,
  PASTE_INSTRUCTION,
  parseCaptureGoogleStateArgs,
  resolveChromeChannel,
  SIGN_IN_PROMPT_MESSAGE,
  serializeStorageState,
  sessionCheckFailureMessage,
  signedInRefusalMessage,
  stdoutValueLine,
} from "./captureGoogleStatePlan";

// Same values as src/platform/browser/PlaywrightChromeLauncher.ts, so the session is captured in a browser set
// up the way the bot's own is.
const NAVIGATION_TIMEOUT_MS = 45000;
const MARKER_TIMEOUT_MS = 10000;

type WaitOutcome = { confirmed: true } | { confirmed: false; cause: AbortCause };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function waitForPerson(
  rl: Interface,
  browser: Browser,
  interruptedSignal: Promise<void>
): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    // resolve only acts once, so whichever event comes first decides.
    rl.once("line", () => resolve({ confirmed: true }));
    rl.once("close", () => resolve({ confirmed: false, cause: "stdin_closed" }));
    browser.once("disconnected", () => resolve({ confirmed: false, cause: "browser_closed" }));
    interruptedSignal.then(() => resolve({ confirmed: false, cause: "interrupted" }));
  });
}

type StorageStateValue = Awaited<ReturnType<BrowserContext["storageState"]>>;
type SessionCheck = { verdict: ReturnType<typeof decideSignedIn>; state: StorageStateValue };

async function checkSession(context: BrowserContext): Promise<SessionCheck> {
  // A fresh page, because the person may have closed or navigated the first tab.
  const page = await context.newPage();
  await page.goto(GOOGLE_ACCOUNT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  // A signed-out browser is expected to be redirected, so the final URL is read once the redirect settles.
  await page.waitForLoadState("load").catch(() => undefined);
  const accountPageUrl = page.url();

  await page.goto(GOOGLE_MEET_HOME_URL, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  const meetSignedInMarkerVisible = await page
    .locator(GOOGLE_MEET_SELECTORS.signedInMarker)
    .first()
    .waitFor({ state: "visible", timeout: MARKER_TIMEOUT_MS })
    .then(
      () => true,
      () => false
    );
  const meetSignInPromptVisible = await page.locator(MEET_SIGN_IN_PROMPT_SELECTOR).first().isVisible();
  const meetHomeUrl = page.url();

  // No argument: a path option would write the state to disk, and this script controls where it goes.
  const state = await context.storageState();
  const verdict = decideSignedIn({
    hasSessionCookie: hasGoogleSessionCookie(state.cookies),
    accountPageUrl,
    meetHomeUrl,
    meetSignedInMarkerVisible,
    meetSignInPromptVisible,
  });
  return { verdict, state };
}

function deliverState(outFile: string | null, state: StorageStateValue): number {
  if (outFile === null) {
    process.stdout.write(stdoutValueLine(encodeStorageState(state)));
    process.stderr.write(PASTE_INSTRUCTION);
    return 0;
  }

  try {
    // mode applies only when the file is created, so exclusive creation is what guarantees 0600 and no overwrite.
    writeFileSync(outFile, serializeStorageState(state), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "code") : null;
    process.stderr.write(outFileWriteFailureMessage(outFile, typeof code === "string" ? code : null));
    return 1;
  }
  process.stderr.write(outFileInstruction(outFile));
  return 0;
}

async function main(): Promise<number> {
  let options: ReturnType<typeof parseCaptureGoogleStateArgs>;
  try {
    options = parseCaptureGoogleStateArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arguments";
    process.stderr.write(`${message}\n\n${CAPTURE_GOOGLE_STATE_USAGE}`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(CAPTURE_GOOGLE_STATE_USAGE);
    return 0;
  }

  const refusal = capturePreflightRefusal(options, {
    stdinIsTty: process.stdin.isTTY === true,
    outFileExists: options.outFile !== null && existsSync(options.outFile),
  });
  if (refusal !== null) {
    process.stderr.write(refusal);
    return 1;
  }

  const channel = resolveChromeChannel(process.env.NOTETAKER_CHROME_CHANNEL);

  let browser: Browser | null = null;
  let rl: Interface | null = null;
  let interrupted = false;
  let wakeOnInterrupt: () => void = () => undefined;
  const interruptedSignal = new Promise<void>((resolve) => {
    wakeOnInterrupt = resolve;
  });
  // Installed before the launch so Ctrl+C at any point closes the browser; the launch below turns off
  // Playwright's own handlers because they would exit the process before this cleanup finished.
  const onSignal = () => {
    interrupted = true;
    wakeOnInterrupt();
    void browser?.close().catch(() => undefined);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    try {
      browser = await chromium.launch({
        channel,
        headless: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
      });
    } catch (error) {
      if (interrupted) {
        process.stderr.write(abortMessage("interrupted"));
        return exitCodeForAbort("interrupted");
      }
      process.stderr.write(
        describeLaunchFailure({ channel, errorName: errorName(error), errorMessage: errorMessageOf(error) })
      );
      return 1;
    }
    if (interrupted) {
      process.stderr.write(abortMessage("interrupted"));
      return exitCodeForAbort("interrupted");
    }

    const context = await browser.newContext({ locale: "en-US", permissions: [], acceptDownloads: false });
    const signInPage = await context.newPage();
    await signInPage.goto(GOOGLE_SIGN_IN_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    process.stderr.write(SIGN_IN_PROMPT_MESSAGE);

    // No output stream and no terminal mode: nothing is echoed to stdout, and Ctrl+C still arrives as a signal.
    rl = createInterface({ input: process.stdin, terminal: false });
    const outcome = await waitForPerson(rl, browser, interruptedSignal);
    if (interrupted) {
      process.stderr.write(abortMessage("interrupted"));
      return exitCodeForAbort("interrupted");
    }
    if (!outcome.confirmed) {
      process.stderr.write(abortMessage(outcome.cause));
      return exitCodeForAbort(outcome.cause);
    }

    let check: SessionCheck;
    try {
      check = await checkSession(context);
    } catch (error) {
      if (interrupted) {
        process.stderr.write(abortMessage("interrupted"));
        return exitCodeForAbort("interrupted");
      }
      // Only the class name is printed: Playwright messages embed call logs.
      process.stderr.write(sessionCheckFailureMessage(errorName(error)));
      return 1;
    }

    if (!check.verdict.signedIn) {
      process.stderr.write(signedInRefusalMessage(check.verdict.reason));
      return 1;
    }

    await browser.close().catch(() => undefined);
    return deliverState(options.outFile, check.state);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    rl?.close();
    await browser?.close().catch(() => undefined);
  }
}

main()
  .catch(() => {
    process.stderr.write("capture-google-state: unexpected error. Nothing was written.\n");
    return 1;
  })
  .then((code) => {
    process.exitCode = code;
  });
