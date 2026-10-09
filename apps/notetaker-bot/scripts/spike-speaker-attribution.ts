// UNVERIFIED AGAINST THE REAL SERVICE (Google Meet in Chrome): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/speaker-attribution-spike.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
// This script has never been executed, not even against a fake page.

import process from "node:process";
import { chromium } from "playwright";

const PROBE_INTERVAL_MS = 1000;
const ACTIVE_LEVEL = 0.05;

type Candidate = { name: string; selector: string };

// Guesses from memory of the meeting page; none of them has been checked against the real page.
const CANDIDATE_SELECTORS: Candidate[] = [
  { name: "participantTile", selector: "[data-participant-id]" },
  { name: "requestedParticipantTile", selector: "[data-requested-participant-id]" },
  { name: "ariaSpeaking", selector: '[aria-label*="speaking" i]' },
  { name: "audioLevelAttribute", selector: "[data-audio-level]" },
  { name: "audioElements", selector: "audio" },
];

type SourceStats = {
  entries: number;
  withLevel: number;
  active: number;
  distinctIds: number;
  maxLevel: number;
};

type ProbeSnapshot = {
  peerConnections: number;
  audioReceivers: number;
  liveRemoteAudioTracks: number;
  unmutedRemoteAudioTracks: number;
  contributing: SourceStats;
  synchronization: SourceStats;
  selectorMatches: Record<string, number>;
};

type ParsedArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "run"; url: string; selectors: string[] };

const USAGE = [
  "Usage: spike-speaker-attribution.ts <meeting-url> [--selector <css>]...",
  "",
  "Opens a headed Chrome on the Google Meet link, lets you join by hand and prints one JSON line of",
  "counts per second. Nothing is recorded and no file is written.",
  "",
  "  --selector <css>  extra candidate selector, repeatable, reported as custom1, custom2, ...",
  "  --help, -h        show this text",
  "",
].join("\n");

function isValidMeetingUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "meet.google.com";
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const selectors: string[] = [];
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--selector") {
      const value = argv[index + 1];
      if (value === undefined) return { kind: "error", message: "--selector needs a value" };
      selectors.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "error", message: `unknown option ${arg}` };
    positionals.push(arg);
  }
  const url = positionals[0];
  if (url === undefined) return { kind: "error", message: "missing meeting URL" };
  if (positionals.length > 1) return { kind: "error", message: "expected exactly one meeting URL" };
  if (!isValidMeetingUrl(url)) {
    return { kind: "error", message: "the URL must be an https://meet.google.com/... link" };
  }
  return { kind: "run", url, selectors };
}

// Runs inside the page, so it must not reference anything outside its own body.
function installProbe(selectors: { name: string; selector: string }[], activeLevel: number): void {
  const connections: RTCPeerConnection[] = [];
  const NativePeerConnection = window.RTCPeerConnection;

  class TrackedPeerConnection extends NativePeerConnection {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      connections.push(this);
    }
  }
  window.RTCPeerConnection = TrackedPeerConnection;

  const summarize = (entries: { source: number; audioLevel?: number }[]) => {
    const ids = new Set<number>();
    let withLevel = 0;
    let active = 0;
    let maxLevel = 0;
    for (const entry of entries) {
      ids.add(entry.source);
      if (typeof entry.audioLevel !== "number") continue;
      withLevel += 1;
      if (entry.audioLevel >= activeLevel) active += 1;
      maxLevel = Math.max(maxLevel, entry.audioLevel);
    }
    return {
      entries: entries.length,
      withLevel,
      active,
      distinctIds: ids.size,
      maxLevel: Math.round(maxLevel * 100) / 100,
    };
  };

  const snapshot = () => {
    const open = connections.filter((connection) => connection.connectionState !== "closed");
    const receivers = open
      .flatMap((connection) => connection.getReceivers())
      .filter((receiver) => receiver.track.kind === "audio");
    const selectorMatches: Record<string, number> = {};
    for (const { name, selector } of selectors) {
      try {
        selectorMatches[name] = document.querySelectorAll(selector).length;
      } catch {
        selectorMatches[name] = -1;
      }
    }
    return {
      peerConnections: open.length,
      audioReceivers: receivers.length,
      liveRemoteAudioTracks: receivers.filter((receiver) => receiver.track.readyState === "live").length,
      unmutedRemoteAudioTracks: receivers.filter((receiver) => receiver.track.muted === false).length,
      contributing: summarize(receivers.flatMap((receiver) => receiver.getContributingSources())),
      synchronization: summarize(receivers.flatMap((receiver) => receiver.getSynchronizationSources())),
      selectorMatches,
    };
  };

  Object.defineProperty(window, "__notetakerSpikeSnapshot", { value: snapshot });
}

// The __name shim covers the helper that a keep-names transform may inject into the stringified
// function; that is a guess about the toolchain, not something observed.
function buildProbeInitScript(selectors: Candidate[]): string {
  return `(() => { const __name = (target) => target; (${installProbe.toString()})(${JSON.stringify(
    selectors
  )}, ${JSON.stringify(ACTIVE_LEVEL)}); })();`;
}

function isSourceStats(value: unknown): value is SourceStats {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    typeof value.entries === "number" &&
    "withLevel" in value &&
    typeof value.withLevel === "number" &&
    "active" in value &&
    typeof value.active === "number" &&
    "distinctIds" in value &&
    typeof value.distinctIds === "number" &&
    "maxLevel" in value &&
    typeof value.maxLevel === "number"
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "number")
  );
}

function isProbeSnapshot(value: unknown): value is ProbeSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "peerConnections" in value &&
    typeof value.peerConnections === "number" &&
    "audioReceivers" in value &&
    typeof value.audioReceivers === "number" &&
    "liveRemoteAudioTracks" in value &&
    typeof value.liveRemoteAudioTracks === "number" &&
    "unmutedRemoteAudioTracks" in value &&
    typeof value.unmutedRemoteAudioTracks === "number" &&
    "contributing" in value &&
    isSourceStats(value.contributing) &&
    "synchronization" in value &&
    isSourceStats(value.synchronization) &&
    "selectorMatches" in value &&
    isNumberRecord(value.selectorMatches)
  );
}

function writeLine(stream: NodeJS.WriteStream, text: string): void {
  stream.write(`${text}\n`);
}

async function readSnapshotLine(
  page: { evaluate(expression: string): Promise<unknown> },
  seconds: number
): Promise<string> {
  try {
    const result = await page.evaluate(
      "typeof window.__notetakerSpikeSnapshot === 'function' ? window.__notetakerSpikeSnapshot() : null"
    );
    if (isProbeSnapshot(result)) return JSON.stringify({ t: seconds, ...result });
    return JSON.stringify({ t: seconds, probe: "not_installed" });
  } catch {
    return JSON.stringify({ t: seconds, probe: "unavailable" });
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    writeLine(process.stderr, parsed.message);
    process.stderr.write(USAGE);
    return 2;
  }

  const candidates: Candidate[] = [
    ...CANDIDATE_SELECTORS,
    ...parsed.selectors.map((selector, index) => ({ name: `custom${index + 1}`, selector })),
  ];

  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext({ acceptDownloads: false, permissions: [] });
  await context.addInitScript({ content: buildProbeInitScript(candidates) });
  const page = await context.newPage();
  try {
    await page.goto(parsed.url);
  } catch (error) {
    writeLine(process.stderr, error instanceof Error ? error.message : "navigation failed");
    await browser.close().catch(() => undefined);
    return 1;
  }

  writeLine(
    process.stderr,
    "Join the call by hand with microphone and camera off. Press Ctrl+C or close the window to finish."
  );

  let stopping = false;
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const requestStop = (): void => {
    if (stopping) return;
    stopping = true;
    resolveStopped();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  page.once("close", requestStop);
  browser.once("disconnected", requestStop);

  const startedAt = Date.now();
  let probing = false;
  const timer = setInterval(() => {
    if (probing || stopping) return;
    probing = true;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    readSnapshotLine(page, seconds)
      .then((line) => writeLine(process.stdout, line))
      .finally(() => {
        probing = false;
      });
  }, PROBE_INTERVAL_MS);

  await stopped;
  clearInterval(timer);
  try {
    await browser.close();
  } catch {
    // The window may already be gone, which is the normal way to finish.
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "unexpected failure"}\n`);
    process.exit(1);
  }
);
