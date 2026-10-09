// UNVERIFIED AGAINST THE REAL SERVICE (Google Meet in Chrome; this script was not run by its authors): written
// from documentation and memory; only its companion modules scripts/meetProbe*.ts are unit-tested. Run the manual
// check in docs/smoke-test-google-meet.md section 12 and record the result in docs/verification-status.md before
// relying on it, then remove this notice.
//
// Usage: yarn workspace @calcom/notetaker-bot meet-probe <meeting-url> --out <absolute-file> [options]
// Joins a Google Meet through the bot's own adapter and launcher, watches the page, leaves, and writes one JSON
// report (mode 0600) about the leave control and the speaker indicators. The meeting URL, credentials, chat and
// audio never reach the report or the terminal.
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Pcm16Frame } from "../src/audio/AudioFrame";
import { getRunnerConfig, type RunnerConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { PlaywrightChromeLauncher } from "../src/platform/browser/PlaywrightChromeLauncher";
import { GoogleMeetAdapter } from "../src/platform/GoogleMeetAdapter";
import type { PlatformEvent } from "../src/platform/PlatformAdapter";
import {
  buildMeetProbeInitScript,
  decodeProbeSamplePayload,
  PROBE_SAMPLE_BINDING,
} from "./meetProbePageScript";
import {
  configFailureMessage,
  EXIT_FAILED,
  EXIT_OK,
  exitCodeForOutcome,
  leakRefusalMessage,
  MEET_PROBE_USAGE,
  type MeetProbePreflightFacts,
  meetProbePreflightRefusal,
  outcomeMessage,
  outFileOpenFailureMessage,
  outFileWriteFailureMessage,
  parseMeetProbeArgs,
  probeConfigEnv,
  reportWrittenMessage,
  resolveCredentialRoute,
  STORAGE_STATE_VARIABLE,
  UNEXPECTED_ERROR_MESSAGE,
  usageErrorOutput,
} from "./meetProbePlan";
import {
  IN_CALL_SELECTOR_KEYS,
  ProbeBrowserLauncher,
  ProbeRecorder,
  sweepSelectors,
} from "./meetProbeRecorder";
import { findLeaks } from "./meetProbeRedaction";
import { buildProbeReport, formatSummary } from "./meetProbeReport";
import {
  afterLeaveStep,
  buildSecrets,
  collectRawNames,
  PROBE_DISPLAY_NAME,
  resolveOutcome,
  sweepKeysForTick,
  terminalOutcomeOf,
  toLogLine,
} from "./meetProbeRun";
import type {
  MeetProbeOptions,
  MeetProbePageOptions,
  ProbeNoticeStatus,
  ProbeOutcome,
  RawAdapterLogLine,
  RawLeaveStep,
  RawPlatformEvent,
  RawProbeRun,
} from "./meetProbeTypes";

// The same bounds the payload decoder in meetProbePageScript.ts enforces.
const PAGE_LIMITS: Omit<MeetProbePageOptions, "intervalMs"> = {
  maxLeaveControls: 32,
  maxTiles: 64,
  maxStringsPerTile: 64,
  maxStringLength: 512,
};
const SAMPLE_WAIT_SLACK_MS = 500;
// The adapter caps its leave click at 3 s and the recording page then observes for up to 3 s before closing.
const LEAVE_WAIT_LIMIT_MS = 20_000;
const FORCED_EXIT_DELAY_MS = 2000;

type Latch = { promise: Promise<void>; open: () => void };

type RunState = {
  admitted: boolean;
  interrupted: boolean;
  terminal: ProbeOutcome | null;
  leaveReturned: boolean;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function errorCode(error: unknown): string | null {
  const code = error instanceof Error ? Reflect.get(error, "code") : null;
  return typeof code === "string" ? code : null;
}

function noticeText(durationSeconds: number): string {
  return `A diagnostic tool is in this call for about ${durationSeconds} seconds. It records page structure and audio levels only: no audio, no video and no chat.`;
}

function createLatch(): Latch {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// The timer is cleared as soon as one of the promises settles, so it cannot hold the process open.
function settleWithin(timeoutMs: number, ...promises: Promise<unknown>[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    for (const promise of promises) promise.then(settle, settle);
  });
}

function isWritableDirectory(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function gatherPreflightFacts(options: MeetProbeOptions, config: RunnerConfig): MeetProbePreflightFacts {
  const directory = path.dirname(options.outFile);
  const outDirectoryExists = existsSync(directory);
  return {
    outFileExists: existsSync(options.outFile),
    outDirectoryExists,
    outDirectoryWritable: outDirectoryExists && isWritableDirectory(directory),
    joinMode: config.google.joinMode,
    hasStorageState: config.google.storageState !== null,
    hasAccountEmail: config.google.email !== null,
    hasAccountPassword: config.google.password !== null,
  };
}

function discardOutFile(fd: number, outFile: string): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed; the file still has to go.
  }
  try {
    unlinkSync(outFile);
  } catch {
    // Nothing left to remove.
  }
}

async function runProbe(
  options: MeetProbeOptions,
  config: RunnerConfig,
  facts: MeetProbePreflightFacts,
  fd: number
): Promise<number> {
  const state: RunState = { admitted: false, interrupted: false, terminal: null, leaveReturned: false };
  const admitted = createLatch();
  const ended = createLatch();
  const isOver = (): boolean => state.interrupted || state.terminal !== null;

  // Never removed: the first signal ends the observation, and any later one must not kill the process while
  // the bot is leaving or the report is being written. The launcher installs no signal handlers of its own.
  const onSignal = (): void => {
    state.interrupted = true;
    ended.open();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const recorder = new ProbeRecorder();
  const adapterLog: RawAdapterLogLine[] = [];
  const logger = createLogger({
    level: "debug",
    base: { component: "meet-probe" },
    write: (line) => {
      const entry = toLogLine(line, recorder.elapsedMs());
      if (entry) adapterLog.push(entry);
    },
  });
  const launcher = new ProbeBrowserLauncher({
    inner: new PlaywrightChromeLauncher({ logger }),
    recorder,
    initScript: buildMeetProbeInitScript({ intervalMs: options.intervalMs, ...PAGE_LIMITS }),
    bindingName: PROBE_SAMPLE_BINDING,
    decodeSample: decodeProbeSamplePayload,
  });
  const adapter = new GoogleMeetAdapter({
    browser: launcher,
    google: config.google,
    chrome: config.chrome,
    logger,
  });

  const platformEvents: RawPlatformEvent[] = [];
  const audio = { frames: 0, nonSilentFrames: 0 };
  const startedAt = new Date().toISOString();
  let written = false;

  try {
    const joined = await adapter
      .join(
        { meetingUrl: options.meetingUrl, displayName: PROBE_DISPLAY_NAME },
        {
          onEvent: (event: PlatformEvent) => {
            platformEvents.push({ tMs: recorder.elapsedMs(), event });
            if (event.type === "admitted") {
              state.admitted = true;
              admitted.open();
            }
            const terminal = terminalOutcomeOf(event);
            if (terminal !== null && state.terminal === null) {
              state.terminal = terminal;
              ended.open();
            }
          },
          // Counted and dropped: no frame or sample is kept.
          onAudioFrame: (frame: Pcm16Frame) => {
            audio.frames += 1;
            if (frame.samples.some((sample) => sample !== 0)) audio.nonSilentFrames += 1;
          },
        }
      )
      .then(
        () => true,
        (error: unknown) => {
          // The run metadata has no place for the error class, so it travels with the captured log lines.
          logger.error("probe: join failed", { errorName: errorName(error) });
          return false;
        }
      );

    let notice: ProbeNoticeStatus = "skipped";
    let observedMs = 0;
    if (joined) {
      await settleWithin(options.admitTimeoutSeconds * 1000, admitted.promise, ended.promise);
    }

    if (joined && state.admitted && !isOver()) {
      if (options.postNotice) {
        notice = await adapter.postChatMessage(noticeText(options.durationSeconds)).then(
          (): ProbeNoticeStatus => "posted",
          (): ProbeNoticeStatus => "failed"
        );
      }

      const observeStartMs = recorder.elapsedMs();
      const deadlineMs = observeStartMs + options.durationSeconds * 1000;
      for (let tick = 0; !isOver() && recorder.elapsedMs() < deadlineMs; tick += 1) {
        await Promise.race([
          recorder.waitForNextSample(options.intervalMs + SAMPLE_WAIT_SLACK_MS),
          ended.promise,
        ]);
        if (isOver()) break;
        const page = launcher.currentPage();
        if (page) await recorder.sweep(page, sweepKeysForTick(tick));
      }
      observedMs = recorder.elapsedMs() - observeStartMs;
    }

    const outcome = resolveOutcome({
      joined,
      admitted: state.admitted,
      interrupted: state.interrupted,
      terminal: state.terminal,
    });

    const preLeaveStartMs = recorder.elapsedMs();
    const preLeavePage = launcher.currentPage();
    // Not through recorder.sweep: these belong to the leave record, not to the observation sweeps.
    const preLeaveSweeps = preLeavePage
      ? await sweepSelectors(preLeavePage, IN_CALL_SELECTOR_KEYS, () => recorder.elapsedMs())
      : [];
    const preLeaveSample = recorder.latestSample();
    const steps: RawLeaveStep[] = [
      { tMs: preLeaveStartMs, label: "pre-leave", durationMs: recorder.elapsedMs() - preLeaveStartMs },
    ];

    const leaveStartMs = recorder.elapsedMs();
    const leaving = adapter.leave().then(
      () => {
        state.leaveReturned = true;
      },
      (error: unknown) => {
        state.leaveReturned = true;
        logger.warn("probe: adapter leave rejected", { errorName: errorName(error) });
      }
    );
    await settleWithin(LEAVE_WAIT_LIMIT_MS, leaving);
    const leaveElapsedMs = recorder.elapsedMs() - leaveStartMs;
    if (!state.leaveReturned) logger.warn("probe: adapter leave did not return in time");
    steps.push({
      tMs: leaveStartMs,
      label: "adapter.leave",
      durationMs: state.leaveReturned ? leaveElapsedMs : null,
    });

    const snapshot = recorder.snapshot();
    const afterLeave = afterLeaveStep({
      leaveStartMs,
      leaveElapsedMs,
      pageCalls: snapshot.pageCalls,
      afterLeave: snapshot.afterLeave,
    });
    if (afterLeave !== null) steps.push(afterLeave);
    if (snapshot.afterLeaveErrorName !== null) {
      logger.warn("probe: after-leave observation failed", { errorName: snapshot.afterLeaveErrorName });
    }
    if (snapshot.droppedSamplePayloads > 0) {
      logger.warn("probe: page sample payloads were dropped", { count: snapshot.droppedSamplePayloads });
    }

    const raw: RawProbeRun = {
      options,
      run: {
        startedAt,
        outcome,
        joinMode: facts.joinMode,
        credentialRoute: resolveCredentialRoute(facts),
        chromeChannel: config.chrome.channel,
        headless: config.chrome.headless,
        platform: process.platform,
        nodeVersion: process.version,
        meetingHost: new URL(options.meetingUrl).host,
        notice,
        observedMs,
      },
      samples: snapshot.samples,
      selectorSweeps: snapshot.selectorSweeps,
      platformEvents,
      audio,
      pageCalls: snapshot.pageCalls,
      leave: {
        preLeave: { tMs: preLeaveStartMs, sweeps: preLeaveSweeps, sample: preLeaveSample },
        steps,
        adapterLog,
        afterLeave: snapshot.afterLeave,
        elapsedMs: leaveElapsedMs,
      },
    };
    const report = buildProbeReport(raw, {
      redactNames: options.redactNames,
      sampleReceipts: snapshot.sampleReceipts,
    });
    const json = `${JSON.stringify(report, null, 2)}\n`;

    const leaks = findLeaks(
      json,
      buildSecrets({
        meetingUrl: options.meetingUrl,
        accountEmail: config.google.email,
        accountPassword: config.google.password,
        storageStateValue: process.env[STORAGE_STATE_VARIABLE],
        redactNames: options.redactNames,
        rawNames: collectRawNames(platformEvents, [
          ...snapshot.samples,
          ...(snapshot.afterLeave?.samples ?? []),
        ]),
      })
    );
    if (leaks.length > 0) {
      process.stderr.write(leakRefusalMessage(leaks));
      return EXIT_FAILED;
    }

    try {
      writeFileSync(fd, json, "utf8");
      closeSync(fd);
      written = true;
    } catch (error) {
      process.stderr.write(outFileWriteFailureMessage(options.outFile, errorCode(error)));
      return EXIT_FAILED;
    }

    process.stdout.write(formatSummary(report.hypotheses, options.outFile));
    process.stderr.write(outcomeMessage(outcome, true));
    process.stderr.write(reportWrittenMessage(options.outFile));
    return exitCodeForOutcome(outcome);
  } catch (error) {
    // Only the class name: error messages can carry page text or the meeting URL.
    process.stderr.write(`${UNEXPECTED_ERROR_MESSAGE}(${errorName(error)})\n`);
    return EXIT_FAILED;
  } finally {
    // leave is idempotent; this only matters when something above threw before the bot left.
    await settleWithin(LEAVE_WAIT_LIMIT_MS, adapter.leave());
    if (!written) discardOutFile(fd, options.outFile);
  }
}

async function main(): Promise<number> {
  let options: MeetProbeOptions;
  try {
    options = parseMeetProbeArgs(process.argv.slice(2));
  } catch (error) {
    // The parser builds its messages from flag names and rules only, never from the meeting URL.
    process.stderr.write(usageErrorOutput(error instanceof Error ? error.message : "invalid arguments"));
    return EXIT_FAILED;
  }
  if (options.help) {
    process.stdout.write(MEET_PROBE_USAGE);
    return EXIT_OK;
  }

  let config: RunnerConfig;
  try {
    config = getRunnerConfig(probeConfigEnv(process.env));
  } catch (error) {
    // getRunnerConfig names variables and rules only, never values.
    process.stderr.write(
      configFailureMessage(error instanceof Error ? error.message : "invalid configuration")
    );
    return EXIT_FAILED;
  }

  const facts = gatherPreflightFacts(options, config);
  const refusal = meetProbePreflightRefusal(options, facts);
  if (refusal !== null) {
    process.stderr.write(refusal);
    return EXIT_FAILED;
  }

  // Created before joining, so a path that cannot be written never costs a meeting. Exclusive creation
  // guarantees no overwrite; fchmod makes the mode exact whatever the umask is.
  let fd: number;
  try {
    fd = openSync(options.outFile, "wx", 0o600);
  } catch (error) {
    process.stderr.write(outFileOpenFailureMessage(options.outFile, errorCode(error)));
    return EXIT_FAILED;
  }
  try {
    fchmodSync(fd, 0o600);
  } catch (error) {
    discardOutFile(fd, options.outFile);
    process.stderr.write(outFileOpenFailureMessage(options.outFile, errorCode(error)));
    return EXIT_FAILED;
  }

  return runProbe(options, config, facts, fd);
}

main()
  .catch(() => {
    process.stderr.write(UNEXPECTED_ERROR_MESSAGE);
    return EXIT_FAILED;
  })
  .then((code) => {
    process.exitCode = code;
    // The report is already written and closed; a browser or page timer that lingers must not keep the
    // process alive, and the delay lets standard output drain first.
    setTimeout(() => process.exit(code), FORCED_EXIT_DELAY_MS).unref();
  });
