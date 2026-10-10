// Turns what a Meet probe run collected into the JSON the owner sends back and into verdicts on the hypotheses
// about the two open defects (the leave click failing, speakers never being named). Pure: no I/O, no clock.

import { DRIVER_LEAVE_TIMEOUT_MS } from "../src/platform/browser/BrowserPlatformAdapter";
import { GOOGLE_MEET_SELECTORS } from "../src/platform/GoogleMeetAdapter";
import type { PlatformEvent } from "../src/platform/PlatformAdapter";
import { hashProbeValue, hashSourceKey } from "./meetProbeHash";
import { NameRedactor } from "./meetProbeRedaction";
import type {
  HypothesisId,
  HypothesisVerdict,
  MeasurementVerdict,
  MeetSelectorKey,
  ProbeOutcome,
  ProbeReport,
  Q1Counts,
  Q2Counts,
  Q2Indicator,
  Q3Counts,
  RawAdapterLogLine,
  RawElementFacts,
  RawLocatedString,
  RawPageSample,
  RawProbeRun,
  RawRtcFacts,
  RawRtcSourceEntry,
  RawSelectorCheck,
  RecordedPageCall,
  ReportElementFacts,
  ReportPlatformEvent,
  ReportSample,
  ReportTileFacts,
  ReportTimelineEntry,
  SelectorSweepResult,
  SourceKind,
} from "./meetProbeTypes";

export const MEET_PROBE_REPORT_VERSION = 2;

// The floor SpeakerAttributor uses for a source to count as talking (minSourceLevel); below it the bot itself
// would ignore the entry, so the probe must not call it speech either.
export const AUDIO_ACTIVE_LEVEL = 0.05;
// A single loud sample can be a join chime or a cough; three keeps one stray sample from deciding a verdict.
export const MIN_AUDIO_ACTIVE_SAMPLES = 3;
// How much more often class or style must change while somebody talks than while nobody does before the
// changes are read as a speaking indicator rather than Meet's ordinary re-rendering.
export const SPEAKING_TOGGLE_RATIO = 2;
// SpeakerAttributor needs the UI signal to cover this share of a passage (minOverlapRatio) to name its speaker.
export const MIN_SPEAKER_COVERAGE = 0.6;
// Three of the adapter's 500 ms polls: a shorter silence inside one participant's signal is flicker, a longer
// one is a new turn.
export const TURN_MERGE_GAP_MS = 1500;
// Shorter turns are a single poll hit and say nothing about coverage.
export const MIN_TURN_MS = 1000;
// Browsers keep a contributing or synchronization source entry for ten seconds, so an age outside that range
// means the entry's timestamp is on another clock or scale.
export const MAX_SOURCE_AGE_MS = 10000;
// The bot closes the page right after the click; an ended text that needs longer than a quarter of a second
// shows Meet had not finished leaving when the page went away.
export const LEAVE_REGISTER_FAST_MS = 250;
// Q3: the receiver's source timestamps are read as being on the page clock when a source that just spoke is
// no more than this far from it.
export const SOURCE_CLOCK_TOLERANCE_MS = 1000;
// Share of judged source entries that must agree (or disagree) before the clock question is settled.
export const CLOCK_AGREEMENT_SHARE = 0.9;
export const MAX_REPORTED_INDICATORS = 5;

const HYPOTHESES: readonly { id: HypothesisId; title: string }[] = [
  { id: "L1", title: "browser closed by the stop signal" },
  { id: "L2", title: "leave selector matches nothing visible" },
  { id: "L3", title: "leave control present but not actionable" },
  { id: "L4", title: "3 s driver cap expires on a slow click" },
  { id: "L5", title: "Meet asks to confirm after the click" },
  { id: "L6", title: "page closes before Meet registers the click" },
  { id: "S1", title: "no speaking label inside a tile" },
  { id: "S2", title: "speaking shown by class or style, not a label" },
  { id: "S3", title: "name not in span.notranslate" },
  { id: "S4", title: "name label hidden from :visible" },
  { id: "S5", title: "indicator flickers under the coverage floor" },
  { id: "S6", title: "names readable but no speaker events" },
  { id: "S7", title: "audio source signal unusable" },
];

const TILE_SELECTOR = "[data-participant-id]";
const TILE_WITH_SPEAKING_LABEL_SELECTOR = '[data-participant-id]:has([aria-label*="speaking" i])';
const SPEAKING_LABEL_SELECTOR = '[aria-label*="speaking" i]';
const TILE_NAME_SPAN_SELECTOR = "[data-participant-id] span.notranslate";
const NAME_SPAN_SELECTOR = "span.notranslate";
// The parts of the adapter's speaker selector the collector counts in the page. One it could not evaluate is
// left out of a sample's checks, so a missing check means "unknown", never zero matches.
const DECOMPOSED_SELECTORS: readonly string[] = [
  TILE_SELECTOR,
  TILE_WITH_SPEAKING_LABEL_SELECTOR,
  SPEAKING_LABEL_SELECTOR,
  TILE_NAME_SPAN_SELECTOR,
  NAME_SPAN_SELECTOR,
];

const NAME_ID_PREFIX = "name:";
// The recorder stores a negative count when a sweep read threw: the count is unknown, never zero.
const isFailedSweep = (sweep: SelectorSweepResult): boolean => sweep.matched < 0 || sweep.visible < 0;
const isUsableSweep = (sweep: SelectorSweepResult): boolean => !isFailedSweep(sweep);
// Class tokens, data-attribute names and aria state values are Meet's own markup, not names, so they are
// written as they are; the cap keeps an unexpectedly long value from carrying free text into the file.
export const MAX_MARKUP_STRING_LENGTH = 64;
// Adapter log fields hold selector keys, error class names ("TimeoutError") and short lower-case tokens such
// as a state or a step; those say which leave outcome occurred and must stay readable. Any other string is
// treated as page text.
const READABLE_LOG_FIELD_VALUE = /^(?:[A-Z][A-Za-z0-9]*Error|[a-z][a-z0-9_]*)$/;
// Meet labels the bot's own tile "You"; learned as a name it would alias every "you" in a UI sentence and
// hide which tile is the bot's.
const SELF_TILE_LABEL = "you";

const REPORT_LIMITS: readonly string[] = [
  "The accessible tree is approximated: role, aria-label, one level of aria-labelledby, title and tooltip only.",
  "Selector sweeps and page calls keep counts and booleans only, never text.",
  "The hit-test is taken at the centre of the element box only.",
  "source_activity events are left out of the timeline; they are all in platformEvents.",
  "Leave hypothesis L1 can only be judged indirectly because the probe sends no stop signal.",
  "Tile and source identifiers are the first 16 hex characters of a salted SHA-256; the salt is random per run and is never written, so hashes cannot be compared between runs or turned back into ids.",
  "Q3 compares source timestamps with the page clock within 1000 ms; at a sample interval above 1000 ms it can read inconclusive.",
];
const SAMPLE_CLOCK_LIMIT =
  "Sample tMs is the time the sample was received; after-leave samples and samples without a receipt carry pageTimeMs instead, which restarts in each new document.";

export type ProbeSampleReceipt = { tMs: number; sequence: number };
export type BuildProbeReportOptions = {
  redactNames: boolean;
  sampleReceipts: readonly ProbeSampleReceipt[];
  salt: string;
};

type TileKeys = { keyOf(participantIdHash: string): string; has(participantIdHash: string): boolean };

function createTileKeys(): TileKeys {
  const keys = new Map<string, string>();
  return {
    keyOf(participantIdHash) {
      const known = keys.get(participantIdHash);
      if (known) return known;
      const key = `tile-${keys.size + 1}`;
      keys.set(participantIdHash, key);
      return key;
    },
    has: (participantIdHash) => keys.has(participantIdHash),
  };
}

const capMarkup = (value: string): string => value.slice(0, MAX_MARKUP_STRING_LENGTH);

function capStates(states: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(states)) result[capMarkup(name)] = capMarkup(value);
  return result;
}

function redactNullable(value: string | null, redactor: NameRedactor): string | null {
  return value === null ? null : redactor.redactOtherString(value);
}

function toReportElement(element: RawElementFacts, redactor: NameRedactor): ReportElementFacts {
  return {
    ...element,
    ariaLabel: redactNullable(element.ariaLabel, redactor),
    title: redactNullable(element.title, redactor),
    tooltip: redactNullable(element.tooltip, redactor),
    text: redactNullable(element.text, redactor),
    dataAttributeNames: element.dataAttributeNames.map(capMarkup),
    ariaStates: capStates(element.ariaStates),
    coveredBy: element.coveredBy
      ? { ...element.coveredBy, ariaLabel: redactNullable(element.coveredBy.ariaLabel, redactor) }
      : null,
  };
}

// Rebuilt field by field so nothing unknown in a page payload can ride along into the file.
const toReportSourceEntry = (entry: RawRtcSourceEntry): RawRtcSourceEntry => ({
  sourceHash: entry.sourceHash,
  audioLevel: entry.audioLevel,
  ageMs: entry.ageMs,
  timestampRaw: entry.timestampRaw,
});

const toReportRtc = (rtc: RawRtcFacts): RawRtcFacts => ({
  peerConnectionCount: rtc.peerConnectionCount,
  receivers: rtc.receivers.map((receiver) => ({
    readyState: receiver.readyState,
    muted: receiver.muted,
    contributingSources: receiver.contributingSources.map(toReportSourceEntry),
    synchronizationSources: receiver.synchronizationSources.map(toReportSourceEntry),
  })),
});

function toReportSample(
  sample: RawPageSample,
  tMs: number,
  tileKeys: TileKeys,
  redactor: NameRedactor
): ReportSample {
  return {
    sequence: sample.sequence,
    tMs,
    pageTimeMs: sample.pageTimeMs,
    leaveControls: sample.leaveControls.map((element) => toReportElement(element, redactor)),
    tiles: sample.tiles.map((tile) => ({
      tileKey: tileKeys.keyOf(tile.participantIdHash),
      participantIdHash: tile.participantIdHash,
      sourceHashes: [...tile.sourceHashes],
      classTokens: tile.classTokens.map(capMarkup),
      classTokenChanges: {
        added: tile.classTokenChanges.added.map(capMarkup),
        removed: tile.classTokenChanges.removed.map(capMarkup),
      },
      strings: tile.strings.map((entry) => ({ ...entry, value: redactor.redactTileString(entry.value) })),
      dataAttributeNames: tile.dataAttributeNames.map(capMarkup),
      ariaStates: capStates(tile.ariaStates),
      mutations: tile.mutations.map((mutation) => ({
        ...mutation,
        attribute: capMarkup(mutation.attribute),
        toggledClassTokens: mutation.toggledClassTokens.map(capMarkup),
      })),
      mutationCount: tile.mutationCount,
    })),
    selectorChecks: sample.selectorChecks,
    rtc: toReportRtc(sample.rtc),
    visibilityState: sample.visibilityState,
    hasFocus: sample.hasFocus,
    dialogCount: sample.dialogCount,
    dialogs: sample.dialogs.map((dialog) => ({
      ...dialog,
      ariaLabel: redactNullable(dialog.ariaLabel, redactor),
    })),
  };
}

function nameOfParticipantId(participantId: string): string | null {
  return participantId.startsWith(NAME_ID_PREFIX) ? participantId.slice(NAME_ID_PREFIX.length) : null;
}

const isLearnedWhole = (entry: RawLocatedString): boolean =>
  entry.isNotranslateSpan && entry.value.trim().toLowerCase() !== SELF_TILE_LABEL;

function learnNames(raw: RawProbeRun, samples: RawPageSample[], tileKeys: TileKeys, redactor: NameRedactor) {
  // Whole names first, so a later tile string that contains one is split around the known name instead of
  // giving a longer run its own alias.
  for (const { event } of raw.platformEvents) {
    if (event.type !== "speaker" && event.type !== "source_identity") continue;
    redactor.learnName(event.name, "event", null);
    const idName = nameOfParticipantId(event.participantId);
    if (idName !== null && idName !== event.name) redactor.learnName(idName, "event", null);
  }
  for (const sample of samples) {
    for (const tile of sample.tiles) {
      const tileKey = tileKeys.keyOf(tile.participantIdHash);
      for (const entry of tile.strings) {
        if (isLearnedWhole(entry)) redactor.learnName(entry.value, entry.where, tileKey);
      }
    }
  }
  for (const sample of samples) {
    for (const tile of sample.tiles) {
      const tileKey = tileKeys.keyOf(tile.participantIdHash);
      for (const entry of tile.strings) {
        if (!isLearnedWhole(entry)) redactor.learnTileString(entry.value, entry.where, tileKey);
      }
    }
  }
}

function createParticipantIdMapper(
  tileKeys: TileKeys,
  redactor: NameRedactor,
  salt: string
): (participantId: string) => string {
  const otherKeys = new Map<string, string>();
  return (participantId) => {
    const idName = nameOfParticipantId(participantId);
    if (idName !== null) return `${NAME_ID_PREFIX}${redactor.redactOtherString(idName)}`;
    const participantIdHash = hashProbeValue(salt, "pid", participantId);
    if (tileKeys.has(participantIdHash)) return tileKeys.keyOf(participantIdHash);
    const known = otherKeys.get(participantId);
    if (known) return known;
    const key = `participant-${otherKeys.size + 1}`;
    otherKeys.set(participantId, key);
    return key;
  };
}

function flattenEvent(
  tMs: number,
  event: PlatformEvent,
  mapParticipantId: (participantId: string) => string,
  redactor: NameRedactor,
  salt: string
): ReportPlatformEvent {
  switch (event.type) {
    case "participant_count":
      return { tMs, type: event.type, count: event.count };
    case "speaker":
      return {
        tMs,
        type: event.type,
        participantId: mapParticipantId(event.participantId),
        name: redactor.redactOtherString(event.name),
        speaking: event.speaking,
      };
    case "source_activity":
      return { tMs, type: event.type, sourceKey: hashSourceKey(salt, event.sourceKey), level: event.level };
    case "source_identity":
      return {
        tMs,
        type: event.type,
        sourceKey: hashSourceKey(salt, event.sourceKey),
        participantId: mapParticipantId(event.participantId),
        name: redactor.redactOtherString(event.name),
      };
    default:
      return { tMs, type: event.type };
  }
}

// The message is left alone: it is a fixed literal of the bot's code, and it is how a reader sees which leave
// outcome occurred.
function redactLogLine(line: RawAdapterLogLine, redactor: NameRedactor): RawAdapterLogLine {
  const fields: RawAdapterLogLine["fields"] = {};
  for (const [name, value] of Object.entries(line.fields)) {
    const readable =
      typeof value !== "string" ||
      Object.hasOwn(GOOGLE_MEET_SELECTORS, value) ||
      READABLE_LOG_FIELD_VALUE.test(value);
    fields[name] = readable ? value : redactor.redactOtherString(value);
  }
  return { ...line, fields };
}

function sourceEntries(sample: ReportSample): RawRtcSourceEntry[] {
  return sample.rtc.receivers.flatMap((receiver) => [
    ...receiver.contributingSources,
    ...receiver.synchronizationSources,
  ]);
}

const isActiveEntry = (entry: RawRtcSourceEntry): boolean =>
  entry.audioLevel !== null && entry.audioLevel > AUDIO_ACTIVE_LEVEL;

const isAudioActive = (sample: ReportSample): boolean => sourceEntries(sample).some(isActiveEntry);

function describeEvent(event: ReportPlatformEvent): string {
  if (event.type === "speaker") return `speaker ${event.name} speaking=${event.speaking}`;
  if (event.type === "participant_count") return `participant_count ${event.count}`;
  if (event.type === "source_identity") return `source_identity ${event.sourceKey} is ${event.name}`;
  return event.type;
}

function describeCall(call: RecordedPageCall): string {
  const target = call.selectorKey ? ` ${call.selectorKey}` : "";
  const outcome = call.errorName ? `threw ${call.errorName}` : "ok";
  return `${call.method}${target} ${outcome} in ${Math.round(call.durationMs)} ms`;
}

function buildTimeline(
  report: Omit<ProbeReport, "timeline" | "hypotheses" | "measurements">
): ReportTimelineEntry[] {
  const entries: ReportTimelineEntry[] = [];
  for (const event of report.platformEvents) {
    if (event.type === "source_activity") continue;
    entries.push({ tMs: event.tMs, kind: "event", summary: describeEvent(event) });
  }
  for (const sample of report.samples) {
    entries.push({
      tMs: sample.tMs,
      kind: "sample",
      summary: `sample ${sample.sequence}: ${sample.tiles.length} tiles, ${sample.leaveControls.length} leave-like controls, ${sample.rtc.receivers.length} receivers, audio ${isAudioActive(sample) ? "active" : "quiet"}, ${sample.dialogCount} dialogs`,
    });
  }
  // Only changes: a selector that keeps the same counts would bury the moments that matter.
  const lastCounts = new Map<MeetSelectorKey, string>();
  for (const sweep of report.selectorSweeps) {
    const counts = `matched ${sweep.matched}, visible ${sweep.visible}`;
    if (lastCounts.get(sweep.selectorKey) === counts) continue;
    lastCounts.set(sweep.selectorKey, counts);
    entries.push({ tMs: sweep.tMs, kind: "sweep", summary: `${sweep.selectorKey}: ${counts}` });
  }
  for (const call of report.pageCalls) {
    if (call.errorName === null && call.tMs < report.leave.preLeave.tMs) continue;
    entries.push({ tMs: call.tMs, kind: "call", summary: describeCall(call) });
  }
  for (const step of report.leave.steps) {
    const duration = step.durationMs === null ? "" : ` (${Math.round(step.durationMs)} ms)`;
    entries.push({ tMs: step.tMs, kind: "leave", summary: `${step.label}${duration}` });
  }
  // Array.prototype.sort is stable, so entries of one moment keep the channel order above.
  return entries.sort((a, b) => a.tMs - b.tMs);
}

function sweptSelectors(sweeps: SelectorSweepResult[]): Record<string, string> {
  const swept: Record<string, string> = {};
  for (const sweep of sweeps) swept[sweep.selectorKey] = GOOGLE_MEET_SELECTORS[sweep.selectorKey];
  return swept;
}

export function buildProbeReport(raw: RawProbeRun, options: BuildProbeReportOptions): ProbeReport {
  const redactor = new NameRedactor({ enabled: options.redactNames });
  const tileKeys = createTileKeys();
  const preLeaveSample = raw.leave.preLeave.sample;
  const afterLeave = raw.leave.afterLeave;
  const everySample = [
    ...raw.samples,
    ...(preLeaveSample ? [preLeaveSample] : []),
    ...(afterLeave ? afterLeave.samples : []),
  ];
  // Keys are fixed before anything is learned so they follow first sight, not the learning order.
  for (const sample of everySample) {
    for (const tile of sample.tiles) tileKeys.keyOf(tile.participantIdHash);
  }
  learnNames(raw, everySample, tileKeys, redactor);

  // The page clock restarts in each new document, so a sample's time on the probe clock is its receipt time.
  const toSample = (sample: RawPageSample, tMs: number = sample.pageTimeMs): ReportSample =>
    toReportSample(sample, tMs, tileKeys, redactor);
  const mapParticipantId = createParticipantIdMapper(tileKeys, redactor, options.salt);

  const withoutVerdicts: Omit<ProbeReport, "timeline" | "hypotheses" | "measurements"> = {
    schemaVersion: 2,
    tool: { name: "meet-probe", version: MEET_PROBE_REPORT_VERSION },
    run: {
      startedAt: raw.run.startedAt,
      durationSeconds: raw.options.durationSeconds,
      intervalMs: raw.options.intervalMs,
      redactNames: options.redactNames,
      outcome: raw.run.outcome,
      joinMode: raw.run.joinMode,
      credentialRoute: raw.run.credentialRoute,
      chrome: { channel: raw.run.chromeChannel, headless: raw.run.headless },
      platform: raw.run.platform,
      nodeVersion: raw.run.nodeVersion,
      meeting: { host: raw.run.meetingHost },
      notice: raw.run.notice,
      observedMs: raw.run.observedMs,
    },
    selectors: {
      swept: sweptSelectors([...raw.selectorSweeps, ...raw.leave.preLeave.sweeps]),
      decomposed: [...DECOMPOSED_SELECTORS],
      limits: [...REPORT_LIMITS, SAMPLE_CLOCK_LIMIT],
    },
    samples: raw.samples.map((sample, index) => toSample(sample, options.sampleReceipts[index]?.tMs)),
    selectorSweeps: raw.selectorSweeps,
    platformEvents: raw.platformEvents.map(({ tMs, event }) =>
      flattenEvent(tMs, event, mapParticipantId, redactor, options.salt)
    ),
    audio: { frames: raw.audio.frames, nonSilentFrames: raw.audio.nonSilentFrames },
    pageCalls: raw.pageCalls,
    leave: {
      preLeave: {
        tMs: raw.leave.preLeave.tMs,
        sweeps: raw.leave.preLeave.sweeps,
        sample: preLeaveSample ? toSample(preLeaveSample, raw.leave.preLeave.tMs) : null,
      },
      steps: raw.leave.steps,
      adapterLog: raw.leave.adapterLog.map((line) => redactLogLine(line, redactor)),
      afterLeave: afterLeave
        ? { ...afterLeave, samples: afterLeave.samples.map((sample) => toSample(sample)) }
        : null,
      elapsedMs: raw.leave.elapsedMs,
    },
    names: redactor.summary(),
  };
  const report: ProbeReport = {
    ...withoutVerdicts,
    timeline: buildTimeline(withoutVerdicts),
    hypotheses: [],
    measurements: [],
  };
  report.hypotheses = evaluateHypotheses(report);
  report.measurements = evaluateMeasurements(report.samples);
  return report;
}

// ---- Hypotheses ----

type Verdict = Omit<HypothesisVerdict, "id">;

const supported = (evidence: string): Verdict => ({ verdict: "supported", evidence });
const excluded = (evidence: string): Verdict => ({ verdict: "excluded", evidence });
const inconclusive = (evidence: string): Verdict => ({ verdict: "inconclusive", evidence });

const ms = (value: number): string => `${Math.round(value)} ms`;

const IN_CALL_LEAVE_OUTCOMES: readonly ProbeOutcome[] = ["completed", "interrupted"];

type LeaveFacts = {
  // Why the leave could not be observed from an admitted call; null when it could.
  notObserved: string | null;
  visibleCheck: boolean | null;
  click: RecordedPageCall | null;
  clickLanded: boolean;
  sweep: SelectorSweepResult | null;
  // The pre-leave read of the leave selector threw, so its counts are unknown.
  sweepFailed: boolean;
  controls: ReportElementFacts[] | null;
  blockedControls: number;
};

function isBlocked(control: ReportElementFacts): boolean {
  return (
    control.box === null ||
    control.disabled ||
    control.hitTest === "other" ||
    control.hitTest === "none" ||
    control.style.pointerEvents === "none"
  );
}

function lastLeaveCall(report: ProbeReport, method: RecordedPageCall["method"]): RecordedPageCall | null {
  const calls = report.pageCalls.filter(
    (call) =>
      call.method === method &&
      call.selectorKey === "leaveCallButton" &&
      call.tMs >= report.leave.preLeave.tMs
  );
  return calls[calls.length - 1] ?? null;
}

function collectLeaveFacts(report: ProbeReport): LeaveFacts {
  const visibleCall = lastLeaveCall(report, "isVisible");
  const click = lastLeaveCall(report, "click");
  const controls = report.leave.preLeave.sample ? report.leave.preLeave.sample.leaveControls : null;
  const sweeps = report.leave.preLeave.sweeps.filter((sweep) => sweep.selectorKey === "leaveCallButton");
  return {
    notObserved: IN_CALL_LEAVE_OUTCOMES.includes(report.run.outcome)
      ? null
      : `the run ended as "${report.run.outcome}" before the probe could leave an admitted call, so the leave was not observed`,
    visibleCheck: visibleCall?.result?.kind === "boolean" ? visibleCall.result.value : null,
    click,
    clickLanded: click !== null && click.errorName === null && click.result !== null,
    sweep: sweeps.find(isUsableSweep) ?? null,
    sweepFailed: sweeps.length > 0 && sweeps.every(isFailedSweep),
    controls,
    blockedControls: controls ? controls.filter(isBlocked).length : 0,
  };
}

const describeClick = (click: RecordedPageCall): string =>
  click.errorName
    ? `the leave click threw ${click.errorName} after ${ms(click.durationMs)}`
    : `the leave click returned after ${ms(click.durationMs)}`;

function judgeL1(report: ProbeReport, facts: LeaveFacts): Verdict {
  const caveat =
    "excluding L1 needs a run under a real stop signal, which the probe never sends, so it stays open";
  if (facts.notObserved) return inconclusive(`Not judged: ${facts.notObserved}; ${caveat}.`);
  const after = report.leave.afterLeave;
  if (facts.click && facts.clickLanded && facts.visibleCheck !== false && after?.endedTextVisible) {
    const latency =
      after.msFromClickToEndedText === null ? "" : ` ${ms(after.msFromClickToEndedText)} after it`;
    return supported(
      `With no stop signal sent the adapter found the leave control, ${describeClick(facts.click)} and the ended text appeared${latency}, so the leave itself works when the browser survives.`
    );
  }
  const clickPart = facts.click ? describeClick(facts.click) : "no leave click was recorded";
  const endedPart = after
    ? `ended text visible=${after.endedTextVisible}`
    : "no after-leave observation was recorded";
  return inconclusive(`Without a stop signal ${clickPart} and ${endedPart}; ${caveat}.`);
}

function judgeL2(facts: LeaveFacts): Verdict {
  if (facts.notObserved) return inconclusive(`Not judged: ${facts.notObserved}.`);
  let sweepPart = "there was no pre-leave sweep of leaveCallButton";
  if (facts.sweepFailed) {
    sweepPart = "the pre-leave selector read of leaveCallButton failed, so its counts are unknown";
  }
  if (facts.sweep) {
    sweepPart = `the pre-leave sweep of leaveCallButton matched ${facts.sweep.matched} and saw ${facts.sweep.visible} visible`;
  }
  const discoveryPart = facts.controls
    ? `discovery found ${facts.controls.length} leave-like controls`
    : "there was no pre-leave page sample";
  const numbers = `${sweepPart} and ${discoveryPart}`;
  if (facts.visibleCheck === false) {
    return supported(
      `The adapter's isVisible(leaveCallButton) returned false, so it returned without clicking; ${numbers}.`
    );
  }
  if (facts.visibleCheck === true) {
    return excluded(`The adapter's isVisible(leaveCallButton) returned true; ${numbers}.`);
  }
  if (!facts.sweep) {
    return inconclusive(`No adapter isVisible(leaveCallButton) call was recorded and ${numbers}.`);
  }
  if (facts.sweep.visible > 0) {
    return excluded(`No adapter isVisible call was recorded, but ${numbers}.`);
  }
  if (facts.controls && facts.controls.length > 0) {
    return supported(`No adapter isVisible call was recorded, but ${numbers}.`);
  }
  return inconclusive(
    `No adapter isVisible call was recorded and ${numbers}, so a leave-like control to compare against is missing.`
  );
}

function judgeL3(facts: LeaveFacts): Verdict {
  if (facts.notObserved) return inconclusive(`Not judged: ${facts.notObserved}.`);
  const hitTest = facts.controls
    ? `${facts.blockedControls} of ${facts.controls.length} leave-like controls were covered, disabled or without a box before leaving`
    : "there was no pre-leave page sample to hit-test";
  if (!facts.click)
    return inconclusive(`No leave click was attempted, so actionability was not tested; ${hitTest}.`);
  if (facts.clickLanded)
    return excluded(`${capitalise(describeClick(facts.click))} without an error; ${hitTest}.`);
  if (facts.click.errorName === "TimeoutError" || facts.blockedControls > 0) {
    return supported(`${capitalise(describeClick(facts.click))}; ${hitTest}.`);
  }
  return inconclusive(
    `${capitalise(describeClick(facts.click))}, which is not a click timeout, and ${hitTest}.`
  );
}

function judgeL4(facts: LeaveFacts): Verdict {
  if (facts.notObserved) return inconclusive(`Not judged: ${facts.notObserved}.`);
  if (!facts.click)
    return inconclusive(
      "No leave click was recorded, so there is no click duration to compare with the cap."
    );
  const comparison = `${describeClick(facts.click)} against the driver cap of ${DRIVER_LEAVE_TIMEOUT_MS} ms`;
  return facts.click.durationMs > DRIVER_LEAVE_TIMEOUT_MS
    ? supported(`${capitalise(comparison)}, so the cap expired first.`)
    : excluded(`${capitalise(comparison)}, so the cap did not expire.`);
}

function afterLeaveDialogCount(report: ProbeReport): number {
  const after = report.leave.afterLeave;
  if (!after) return 0;
  return Math.max(after.dialogKeysVisible.length, ...after.samples.map((sample) => sample.dialogCount));
}

function judgeL5(report: ProbeReport, facts: LeaveFacts): Verdict {
  if (facts.notObserved) return inconclusive(`Not judged: ${facts.notObserved}.`);
  const after = report.leave.afterLeave;
  if (!after)
    return inconclusive(
      "No after-leave observation was recorded, so a confirmation dialog could not be seen."
    );
  if (!facts.clickLanded) {
    return inconclusive("The leave click did not land, so what Meet shows after a click was not observed.");
  }
  const dialogs = afterLeaveDialogCount(report);
  const numbers = `after the click ${dialogs} dialogs were present and ended text visible=${after.endedTextVisible} within ${ms(after.observedMs)}`;
  return dialogs > 0 && !after.endedTextVisible
    ? supported(`${capitalise(numbers)}.`)
    : excluded(`${capitalise(numbers)}.`);
}

function judgeL6(report: ProbeReport, facts: LeaveFacts): Verdict {
  if (facts.notObserved) return inconclusive(`Not judged: ${facts.notObserved}.`);
  const after = report.leave.afterLeave;
  if (!after)
    return inconclusive(
      "No after-leave observation was recorded, so the time from click to ended text is missing."
    );
  if (!facts.clickLanded) {
    return inconclusive("The leave click did not land, so the time from click to ended text is missing.");
  }
  const latency = after.msFromClickToEndedText;
  if (latency === null) {
    return inconclusive(
      `The ended text ${after.endedTextVisible ? "appeared but its delay was not measured" : `did not appear within ${ms(after.observedMs)} of the click`}, so the time Meet needs is missing.`
    );
  }
  return latency > LEAVE_REGISTER_FAST_MS
    ? supported(
        `Meet needed ${ms(latency)} after the click to show the ended text (threshold ${LEAVE_REGISTER_FAST_MS} ms), while the bot closes the page right after the click.`
      )
    : excluded(
        `Meet showed the ended text ${ms(latency)} after the click, within the ${LEAVE_REGISTER_FAST_MS} ms threshold.`
      );
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// The collector and this module each spell the decomposed selectors; quotes and spaces must not decide a match.
const normaliseSelector = (selector: string): string => selector.replace(/["'\s]/g, "");

function checkOf(sample: ReportSample, selector: string): RawSelectorCheck | null {
  const wanted = normaliseSelector(selector);
  return sample.selectorChecks.find((check) => normaliseSelector(check.selector) === wanted) ?? null;
}

type SpeakerFacts = {
  samples: ReportSample[];
  active: ReportSample[];
  quiet: ReportSample[];
  speakerSweeps: SelectorSweepResult[];
  // activeSpeakerName reads that threw: their counts are unknown.
  failedSpeakerSweeps: number;
  speakerEvents: ReportPlatformEvent[];
};

function collectSpeakerFacts(report: ProbeReport): SpeakerFacts {
  return {
    samples: report.samples,
    active: report.samples.filter(isAudioActive),
    quiet: report.samples.filter((sample) => !isAudioActive(sample)),
    speakerSweeps: report.selectorSweeps.filter(
      (sweep) => sweep.selectorKey === "activeSpeakerName" && isUsableSweep(sweep)
    ),
    failedSpeakerSweeps: report.selectorSweeps.filter(
      (sweep) => sweep.selectorKey === "activeSpeakerName" && isFailedSweep(sweep)
    ).length,
    speakerEvents: report.platformEvents.filter((event) => event.type === "speaker"),
  };
}

const maxOf = (values: number[]): number => values.reduce((max, value) => Math.max(max, value), 0);

function noSpeechReason(facts: SpeakerFacts): string | null {
  if (facts.samples.length === 0) return "no page samples were collected";
  if (facts.active.length < MIN_AUDIO_ACTIVE_SAMPLES) {
    return `only ${facts.active.length} of ${facts.samples.length} samples had a WebRTC source level above ${AUDIO_ACTIVE_LEVEL} (${MIN_AUDIO_ACTIVE_SAMPLES} needed), so nobody verifiably spoke`;
  }
  return null;
}

// Among the samples with audio: how many the page could evaluate the tile label selector in, and in how many
// of those a tile held a "speaking" label.
function labelledActiveSamples(facts: SpeakerFacts): { checked: number; labelled: number } {
  const checks = facts.active.flatMap((sample) => checkOf(sample, TILE_WITH_SPEAKING_LABEL_SELECTOR) ?? []);
  return { checked: checks.length, labelled: checks.filter((check) => check.matched > 0).length };
}

const missingCheck = (selector: string, missing: number, total: number, unit: string): string =>
  `the page could not evaluate ${selector} in ${missing} of ${total} ${unit}, and a missing check is not zero matches`;

function judgeS1(facts: SpeakerFacts): Verdict {
  const reason = noSpeechReason(facts);
  if (reason) return inconclusive(`Not judged: ${reason}.`);
  const { checked, labelled } = labelledActiveSamples(facts);
  if (labelled === 0 && checked < facts.active.length) {
    return inconclusive(
      `Not judged: ${missingCheck(TILE_WITH_SPEAKING_LABEL_SELECTOR, facts.active.length - checked, facts.active.length, "samples with audio")}.`
    );
  }
  if (labelled === 0 && facts.speakerSweeps.length === 0 && facts.failedSpeakerSweeps > 0) {
    return inconclusive(
      `Not judged: the selector read failed in all ${facts.failedSpeakerSweeps} activeSpeakerName sweeps, so what the adapter's selector matches is unknown (a tile held a "speaking" label in 0 of ${facts.active.length} samples with audio).`
    );
  }
  const labelChecks = facts.samples.flatMap((sample) => checkOf(sample, SPEAKING_LABEL_SELECTOR) ?? []);
  const anyLabel =
    labelChecks.length === 0
      ? "could not be evaluated"
      : `matched at most ${maxOf(labelChecks.map((check) => check.matched))}`;
  const sweepMatched = maxOf(facts.speakerSweeps.map((sweep) => sweep.matched));
  const numbers = `a tile held a "speaking" label in ${labelled} of ${checked} checked samples with audio, activeSpeakerName matched at most ${sweepMatched} in ${facts.speakerSweeps.length} sweeps (${facts.failedSpeakerSweeps} more reads failed) and ${SPEAKING_LABEL_SELECTOR} ${anyLabel} anywhere on the page`;
  return labelled === 0 && sweepMatched === 0
    ? supported(`${capitalise(numbers)}.`)
    : excluded(`${capitalise(numbers)}.`);
}

function styleMutations(samples: ReportSample[]): { count: number; tokens: Map<string, number> } {
  let count = 0;
  const tokens = new Map<string, number>();
  for (const sample of samples) {
    for (const tile of sample.tiles) {
      for (const mutation of tile.mutations) {
        if (mutation.attribute !== "class" && mutation.attribute !== "style") continue;
        count += mutation.count;
        for (const token of mutation.toggledClassTokens) tokens.set(token, (tokens.get(token) ?? 0) + 1);
      }
    }
  }
  return { count, tokens };
}

function judgeS2(facts: SpeakerFacts): Verdict {
  const reason = noSpeechReason(facts);
  if (reason) return inconclusive(`Not judged: ${reason}.`);
  const activeWithTiles = facts.active.filter((sample) => sample.tiles.length > 0);
  const quietWithTiles = facts.quiet.filter((sample) => sample.tiles.length > 0);
  if (activeWithTiles.length === 0) {
    return inconclusive(
      `Not judged: none of the ${facts.active.length} samples with audio held a participant tile.`
    );
  }
  const { checked, labelled } = labelledActiveSamples(facts);
  if (labelled > 0) {
    return excluded(
      `A tile held a "speaking" label in ${labelled} of ${checked} checked samples with audio, so speaking is shown by a label.`
    );
  }
  if (checked < facts.active.length) {
    return inconclusive(
      `Not judged, a label cannot be ruled out: ${missingCheck(TILE_WITH_SPEAKING_LABEL_SELECTOR, facts.active.length - checked, facts.active.length, "samples with audio")}.`
    );
  }
  const active = styleMutations(activeWithTiles);
  const quiet = styleMutations(quietWithTiles);
  const activeRate = active.count / activeWithTiles.length;
  const quietRate = quietWithTiles.length === 0 ? 0 : quiet.count / quietWithTiles.length;
  const topTokens = Array.from(active.tokens)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([token]) => token);
  const numbers = `class or style changed ${active.count} times in ${activeWithTiles.length} samples with audio (${activeRate.toFixed(2)} per sample) against ${quiet.count} times in ${quietWithTiles.length} quiet samples (${quietRate.toFixed(2)} per sample)${topTokens.length > 0 ? `, most toggled class tokens ${topTokens.join(", ")}` : ""}`;
  if (active.count === 0) return excluded(`No speaking label and no indicator either: ${numbers}.`);
  if (quietWithTiles.length < MIN_AUDIO_ACTIVE_SAMPLES) {
    return inconclusive(
      `Too few quiet samples to compare with (${MIN_AUDIO_ACTIVE_SAMPLES} needed): ${numbers}.`
    );
  }
  return active.count >= MIN_AUDIO_ACTIVE_SAMPLES && activeRate >= SPEAKING_TOGGLE_RATIO * quietRate
    ? supported(`No speaking label, and ${numbers}, at least ${SPEAKING_TOGGLE_RATIO} times the quiet rate.`)
    : inconclusive(
        `No speaking label, but the changes do not follow the audio (${SPEAKING_TOGGLE_RATIO} times the quiet rate needed): ${numbers}.`
      );
}

function judgeS3(report: ProbeReport, facts: SpeakerFacts): Verdict {
  const withTiles = facts.samples.filter((sample) => sample.tiles.length > 0);
  if (withTiles.length === 0) {
    return inconclusive(
      `Not judged: none of the ${facts.samples.length} page samples held a participant tile.`
    );
  }
  const tileStrings = withTiles.flatMap((sample) => sample.tiles.flatMap((tile) => tile.strings));
  const spanStrings = tileStrings.filter((entry) => entry.isNotranslateSpan).length;
  const checks = withTiles.flatMap((sample) => checkOf(sample, TILE_NAME_SPAN_SELECTOR) ?? []);
  const checked = checks.length;
  const spanMatched = maxOf(checks.map((check) => check.matched));
  const labelOnly = report.names.filter(
    (name) => name.tileCount > 0 && !name.locations.includes("text")
  ).length;
  const numbers = `${TILE_NAME_SPAN_SELECTOR} matched at most ${spanMatched} in ${checked} checked samples, ${spanStrings} of ${tileStrings.length} tile strings sat in a span.notranslate and ${labelOnly} of ${report.names.length} aliased names appeared only in a label, title or tooltip`;
  if (spanMatched > 0 || spanStrings > 0) return excluded(`${capitalise(numbers)}.`);
  if (checked < withTiles.length) {
    return inconclusive(
      `Not judged: ${missingCheck(TILE_NAME_SPAN_SELECTOR, withTiles.length - checked, withTiles.length, "samples with tiles")} (${numbers}).`
    );
  }
  return supported(`${capitalise(numbers)}.`);
}

function judgeS4(facts: SpeakerFacts): Verdict {
  const failed = facts.failedSpeakerSweeps;
  if (facts.samples.length === 0 && facts.speakerSweeps.length === 0 && failed === 0) {
    return inconclusive("Not judged: no page samples and no activeSpeakerName sweeps were collected.");
  }
  const evaluated = facts.samples.flatMap((sample) => checkOf(sample, TILE_NAME_SPAN_SELECTOR) ?? []);
  const missing = facts.samples.length - evaluated.length;
  const spanChecks = evaluated.filter((check) => check.matched > 0);
  const candidates = [...spanChecks, ...facts.speakerSweeps.filter((sweep) => sweep.matched > 0)];
  const hidden = candidates.filter((entry) => entry.visible === 0).length;
  const shown = candidates.length - hidden;
  if (candidates.length === 0 && failed > 0 && facts.speakerSweeps.length === 0) {
    return inconclusive(
      `Not judged: the selector read failed in all ${failed} activeSpeakerName sweeps and no in-page name label matched in ${facts.samples.length} samples.`
    );
  }
  if (candidates.length === 0) {
    return inconclusive(
      missing > 0
        ? `Not judged: ${missingCheck(TILE_NAME_SPAN_SELECTOR, missing, facts.samples.length, "samples")}, and no other name-label reading matched.`
        : `Not judged: a name label never matched at all (${facts.samples.length} samples, ${facts.speakerSweeps.length} activeSpeakerName sweeps), so there was nothing to hide.`
    );
  }
  const numbers = `of ${candidates.length} name-label readings that matched (${spanChecks.length} in-page, ${candidates.length - spanChecks.length} activeSpeakerName sweeps, ${failed} more sweep reads failed), ${hidden} had 0 visible and ${shown} had a visible match`;
  if (shown > 0) return excluded(`${capitalise(numbers)}.`);
  if (missing > 0) {
    return inconclusive(
      `Not judged: ${missingCheck(TILE_NAME_SPAN_SELECTOR, missing, facts.samples.length, "samples")} (${numbers}).`
    );
  }
  return supported(`${capitalise(numbers)}.`);
}

type Turn = { spanMs: number; duty: number };

function speakerTurns(report: ProbeReport, facts: SpeakerFacts): Turn[] {
  const lastEventMs = maxOf(report.platformEvents.map((event) => event.tMs));
  const openSince = new Map<string, number>();
  const intervals = new Map<string, { startMs: number; endMs: number }[]>();
  const close = (participantId: string, endMs: number): void => {
    const startMs = openSince.get(participantId);
    if (startMs === undefined) return;
    openSince.delete(participantId);
    const list = intervals.get(participantId) ?? [];
    list.push({ startMs, endMs });
    intervals.set(participantId, list);
  };
  for (const event of facts.speakerEvents) {
    const participantId = event.participantId ?? "";
    if (event.speaking) {
      if (!openSince.has(participantId)) openSince.set(participantId, event.tMs);
    } else close(participantId, event.tMs);
  }
  for (const participantId of Array.from(openSince.keys())) close(participantId, lastEventMs);

  const turns: Turn[] = [];
  for (const list of intervals.values()) {
    let startMs = 0;
    let endMs = 0;
    let spokenMs = 0;
    let open = false;
    const flush = (): void => {
      if (open && endMs - startMs >= MIN_TURN_MS) {
        turns.push({ spanMs: endMs - startMs, duty: spokenMs / (endMs - startMs) });
      }
    };
    for (const interval of list) {
      if (open && interval.startMs - endMs <= TURN_MERGE_GAP_MS) {
        endMs = interval.endMs;
        spokenMs += interval.endMs - interval.startMs;
        continue;
      }
      flush();
      open = true;
      startMs = interval.startMs;
      endMs = interval.endMs;
      spokenMs = interval.endMs - interval.startMs;
    }
    flush();
  }
  return turns;
}

function judgeS5(report: ProbeReport, facts: SpeakerFacts): Verdict {
  const speaking = facts.speakerEvents.filter((event) => event.speaking).length;
  if (speaking === 0) {
    return inconclusive(
      `Not judged: ${facts.speakerEvents.length} speaker events arrived and none said somebody was speaking, so there is no turn to measure.`
    );
  }
  const turns = speakerTurns(report, facts);
  if (turns.length === 0) {
    return inconclusive(
      `Not judged: ${facts.speakerEvents.length} speaker events arrived but no turn lasted ${MIN_TURN_MS} ms.`
    );
  }
  const under = turns.filter((turn) => turn.duty < MIN_SPEAKER_COVERAGE).length;
  const lowest = Math.min(...turns.map((turn) => turn.duty));
  const numbers = `${under} of ${turns.length} turns (from ${facts.speakerEvents.length} speaker events) had the indicator on for less than ${MIN_SPEAKER_COVERAGE} of the turn, lowest ${lowest.toFixed(2)}`;
  if (under === 0) return excluded(`${capitalise(numbers)}.`);
  return under * 2 >= turns.length
    ? supported(`${capitalise(numbers)}.`)
    : inconclusive(`Fewer than half the turns fell short: ${numbers}.`);
}

function judgeS6(facts: SpeakerFacts): Verdict {
  if (facts.speakerSweeps.length === 0) {
    return inconclusive(
      facts.failedSpeakerSweeps > 0
        ? `Not judged: the selector read failed in all ${facts.failedSpeakerSweeps} activeSpeakerName sweeps.`
        : "Not judged: no activeSpeakerName sweep was recorded."
    );
  }
  const readable = facts.speakerSweeps.filter((sweep) => sweep.visible > 0).length;
  const numbers = `activeSpeakerName had a visible match in ${readable} of ${facts.speakerSweeps.length} sweeps (${facts.failedSpeakerSweeps} more reads failed) and ${facts.speakerEvents.length} speaker events arrived`;
  if (readable === 0) {
    return inconclusive(`Not judged, the adapter had no name to read: ${numbers}.`);
  }
  return facts.speakerEvents.length === 0
    ? supported(`${capitalise(numbers)}.`)
    : excluded(`${capitalise(numbers)}.`);
}

// Participants other than the bot; null when neither a count event nor a tile was seen.
function otherParticipants(report: ProbeReport): number | null {
  const counts = report.platformEvents.flatMap((event) =>
    event.type === "participant_count" && event.count !== undefined ? [event.count] : []
  );
  // Both sources may include the bot itself, so one is taken off: undercounting keeps the verdict cautious.
  if (counts.length > 0) return Math.max(0, maxOf(counts) - 1);
  // One participant can own two tile elements in a sample (a video tile and a people-list entry).
  const tiles = maxOf(report.samples.map((sample) => new Set(sample.tiles.map((tile) => tile.tileKey)).size));
  return tiles > 0 ? tiles - 1 : null;
}

function judgeS7(report: ProbeReport, facts: SpeakerFacts): Verdict {
  if (facts.samples.length === 0) return inconclusive("Not judged: no page samples were collected.");
  const entries = facts.samples.flatMap(sourceEntries);
  const withLevel = entries.filter((entry) => entry.audioLevel !== null);
  const offClock = withLevel.filter(
    (entry) => entry.ageMs === null || Math.abs(entry.ageMs) > MAX_SOURCE_AGE_MS
  ).length;
  const activeSources = new Set(entries.filter(isActiveEntry).map((entry) => entry.sourceHash)).size;
  const receivers = maxOf(facts.samples.map((sample) => sample.rtc.receivers.length));
  const others = otherParticipants(report);
  const numbers = `at most ${receivers} audio receivers for ${others ?? "an unknown number of"} other participants, ${entries.length} source entries of which ${withLevel.length} carried a level, ${offClock} of those had an age outside ${MAX_SOURCE_AGE_MS} ms, ${activeSources} distinct sources rose above ${AUDIO_ACTIVE_LEVEL}, and ${report.audio.nonSilentFrames} of ${report.audio.frames} captured audio frames were non-silent`;
  if (activeSources === 0 && report.audio.nonSilentFrames === 0) {
    return inconclusive(`Not judged, nobody verifiably spoke: ${numbers}.`);
  }
  if (withLevel.length === 0)
    return supported(`Audio was heard but no source entry carried a level: ${numbers}.`);
  if (offClock * 2 >= withLevel.length) {
    return supported(`The source timestamps are on an unusable scale: ${numbers}.`);
  }
  if (activeSources === 0) return supported(`Audio was heard but no source level rose with it: ${numbers}.`);
  if (others === null || others < 2) {
    return inconclusive(
      `Fewer than two other participants, so whether sources tell people apart was not tested: ${numbers}.`
    );
  }
  return activeSources >= 2
    ? excluded(`Sources carried levels, usable ages and told speakers apart: ${numbers}.`)
    : inconclusive(
        `Only one source was ever active, so whether sources tell people apart was not tested: ${numbers}.`
      );
}

export function evaluateHypotheses(report: ProbeReport): HypothesisVerdict[] {
  const leave = collectLeaveFacts(report);
  const speakers = collectSpeakerFacts(report);
  const verdicts: Record<HypothesisId, Verdict> = {
    L1: judgeL1(report, leave),
    L2: judgeL2(leave),
    L3: judgeL3(leave),
    L4: judgeL4(leave),
    L5: judgeL5(report, leave),
    L6: judgeL6(report, leave),
    S1: judgeS1(speakers),
    S2: judgeS2(speakers),
    S3: judgeS3(report, speakers),
    S4: judgeS4(speakers),
    S5: judgeS5(report, speakers),
    S6: judgeS6(speakers),
    S7: judgeS7(report, speakers),
  };
  return HYPOTHESES.map(({ id }) => ({ id, ...verdicts[id] }));
}

// ---- Speech measurements ----

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const share = (count: number, total: number): number => (total === 0 ? 0 : count / total);

type KindedEntry = { kind: SourceKind; entry: RawRtcSourceEntry; speech: boolean };
type SpeechSample = { sample: ReportSample; entries: KindedEntry[]; active: boolean };

// A browser keeps a source entry, with its last level, for ten seconds after the last packet. An entry whose
// timestamp has not moved since the previous sample therefore says nothing about who talks now.
function toSpeechSamples(samples: readonly ReportSample[]): SpeechSample[] {
  let previousStamps = new Set<string>();
  return samples.map((sample) => {
    const stamps = new Set<string>();
    const entries: KindedEntry[] = [];
    for (const receiver of sample.rtc.receivers) {
      const lists: [SourceKind, RawRtcSourceEntry[]][] = [
        ["csrc", receiver.contributingSources],
        ["ssrc", receiver.synchronizationSources],
      ];
      for (const [kind, list] of lists) {
        for (const entry of list) {
          const stamp = entry.timestampRaw === null ? null : `${entry.sourceHash}|${entry.timestampRaw}`;
          if (stamp !== null) stamps.add(stamp);
          const stale = stamp !== null && previousStamps.has(stamp);
          entries.push({ kind, entry, speech: !stale && isActiveEntry(entry) });
        }
      }
    }
    previousStamps = stamps;
    return { sample, entries, active: entries.some((item) => item.speech) };
  });
}

// Two elements of one participant (a video tile and a people-list entry) share a tile key and count once.
function tilesByKey(sample: ReportSample): Map<string, ReportTileFacts[]> {
  const byKey = new Map<string, ReportTileFacts[]>();
  for (const tile of sample.tiles) {
    const list = byKey.get(tile.tileKey) ?? [];
    list.push(tile);
    byKey.set(tile.tileKey, list);
  }
  return byKey;
}

function judgeQ1(speechSamples: SpeechSample[]): MeasurementVerdict {
  const counts: Q1Counts = {
    samples: speechSamples.length,
    activeSamples: 0,
    activeSamplesWithTiles: 0,
    tilesSeen: 0,
    tilesWithSource: 0,
    receiverSources: { csrc: 0, ssrc: 0 },
    linkedTiles: 0,
    matchedEntries: { csrc: 0, ssrc: 0 },
    soloSamplesByTile: {},
    tilesWithSoloSpeech: 0,
    multiActiveSamples: 0,
    unlinkedActiveSamples: 0,
  };
  const tilesSeen = new Set<string>();
  const tilesWithSource = new Set<string>();
  const linked = new Set<string>();
  const receiverSources: Record<SourceKind, Set<string>> = { csrc: new Set(), ssrc: new Set() };

  for (const { sample, entries, active } of speechSamples) {
    const tiles = tilesByKey(sample);
    const sourcesOfTile = new Map<string, Set<string>>();
    for (const [tileKey, elements] of tiles) {
      tilesSeen.add(tileKey);
      const hashes = new Set(elements.flatMap((element) => element.sourceHashes));
      sourcesOfTile.set(tileKey, hashes);
      if (hashes.size > 0) tilesWithSource.add(tileKey);
    }
    const speechHashes = new Set<string>();
    for (const { kind, entry, speech } of entries) {
      receiverSources[kind].add(entry.sourceHash);
      if (speech) speechHashes.add(entry.sourceHash);
      for (const [tileKey, hashes] of sourcesOfTile) {
        if (hashes.has(entry.sourceHash)) linked.add(tileKey);
      }
    }
    const activeTiles = new Set<string>();
    for (const [tileKey, hashes] of sourcesOfTile) {
      if (Array.from(hashes).some((hash) => speechHashes.has(hash))) activeTiles.add(tileKey);
    }
    for (const { kind, entry, speech } of entries) {
      if (!speech) continue;
      if (Array.from(sourcesOfTile.values()).some((hashes) => hashes.has(entry.sourceHash))) {
        counts.matchedEntries[kind] += 1;
      }
    }
    if (!active) continue;
    counts.activeSamples += 1;
    if (tiles.size === 0) continue;
    counts.activeSamplesWithTiles += 1;
    if (activeTiles.size === 1) {
      const [only] = activeTiles;
      if (only !== undefined) counts.soloSamplesByTile[only] = (counts.soloSamplesByTile[only] ?? 0) + 1;
    } else if (activeTiles.size >= 2) counts.multiActiveSamples += 1;
    else counts.unlinkedActiveSamples += 1;
  }
  counts.tilesSeen = tilesSeen.size;
  counts.tilesWithSource = tilesWithSource.size;
  counts.linkedTiles = linked.size;
  counts.receiverSources = { csrc: receiverSources.csrc.size, ssrc: receiverSources.ssrc.size };
  counts.tilesWithSoloSpeech = Object.values(counts.soloSamplesByTile).filter(
    (solo) => solo >= MIN_AUDIO_ACTIVE_SAMPLES
  ).length;

  const solo = Object.entries(counts.soloSamplesByTile)
    .map(([tileKey, value]) => `${tileKey} ${value}`)
    .join(", ");
  const numbers = `${counts.activeSamples} samples with speech (${counts.activeSamplesWithTiles} with a tile), ${counts.tilesWithSource} of ${counts.tilesSeen} tiles carried a source, ${counts.linkedTiles} tiles matched a receiver source, solo samples per tile ${solo === "" ? "none" : solo}, ${counts.multiActiveSamples} samples with several matching tiles, ${counts.unlinkedActiveSamples} with speech and no matching tile, matched speech entries ${counts.matchedEntries.csrc} csrc and ${counts.matchedEntries.ssrc} ssrc`;
  const verdict = (kind: MeasurementVerdict["verdict"], evidence: string): MeasurementVerdict => ({
    id: "Q1",
    verdict: kind,
    evidence,
    counts,
  });

  if (counts.samples === 0) return verdict("inconclusive", "Not judged: no page samples were collected.");
  if (counts.activeSamples < MIN_AUDIO_ACTIVE_SAMPLES) {
    return verdict(
      "inconclusive",
      `Not judged, nobody verifiably spoke: only ${counts.activeSamples} of ${counts.samples} samples had a source level above ${AUDIO_ACTIVE_LEVEL} (${MIN_AUDIO_ACTIVE_SAMPLES} needed).`
    );
  }
  if (counts.activeSamplesWithTiles < MIN_AUDIO_ACTIVE_SAMPLES) {
    return verdict(
      "inconclusive",
      `Not judged: only ${counts.activeSamplesWithTiles} samples with speech held a tile to compare with (${MIN_AUDIO_ACTIVE_SAMPLES} needed).`
    );
  }
  if (counts.tilesWithSource === 0) {
    return verdict("excluded", `No tile carried a data-ssrc value: ${numbers}.`);
  }
  if (counts.linkedTiles === 0) {
    return verdict(
      "excluded",
      `Tile source hashes never equalled a receiver source (the data-ssrc value may have another format): ${numbers}.`
    );
  }
  if (counts.tilesWithSoloSpeech >= 2) {
    return verdict(
      "supported",
      `Each of ${counts.tilesWithSoloSpeech} tiles was the only matching one for at least ${MIN_AUDIO_ACTIVE_SAMPLES} samples: ${numbers}.`
    );
  }
  const missing =
    Object.keys(counts.soloSamplesByTile).length <= 1
      ? "only one tile was ever the single matching one, so telling speakers apart was not tested"
      : `fewer than ${MIN_AUDIO_ACTIVE_SAMPLES} solo samples for the second tile`;
  return verdict("inconclusive", `Not settled, ${missing}: ${numbers}.`);
}

type IndicatorTally = {
  name: string;
  kind: Q2Indicator["kind"];
  measure: Q2Indicator["measure"];
  speech: number;
  silence: number;
  tiles: Set<string>;
};

const describeIndicators = (indicators: Q2Indicator[]): string =>
  indicators
    .slice(0, 3)
    .map(
      (item) =>
        `${item.name} (${item.kind}, ${item.measure}, ${item.speechRate} per speech sample against ${item.silenceRate} per quiet one)`
    )
    .join("; ");

function judgeQ2(speechSamples: SpeechSample[]): MeasurementVerdict {
  const tallies = new Map<string, IndicatorTally>();
  const candidates = new Set<string>();
  const count = (
    name: string,
    kind: Q2Indicator["kind"],
    measure: Q2Indicator["measure"],
    active: boolean,
    tileKey: string
  ): void => {
    candidates.add(name);
    const id = `${measure}|${name}`;
    const tally = tallies.get(id) ?? { name, kind, measure, speech: 0, silence: 0, tiles: new Set() };
    tallies.set(id, tally);
    if (active) {
      tally.speech += 1;
      tally.tiles.add(tileKey);
    } else tally.silence += 1;
  };
  let activeSamplesWithTiles = 0;
  let quietSamplesWithTiles = 0;
  let activeTileSamples = 0;
  let quietTileSamples = 0;

  for (const { sample, active } of speechSamples) {
    const tiles = tilesByKey(sample);
    if (tiles.size === 0) continue;
    if (active) {
      activeSamplesWithTiles += 1;
      activeTileSamples += tiles.size;
    } else {
      quietSamplesWithTiles += 1;
      quietTileSamples += tiles.size;
    }
    for (const [tileKey, elements] of tiles) {
      const toggledClasses = new Set<string>();
      const toggledAttributes = new Set<string>();
      const present = new Set<string>();
      for (const element of elements) {
        for (const token of element.classTokens) present.add(token);
        for (const token of [...element.classTokenChanges.added, ...element.classTokenChanges.removed]) {
          toggledClasses.add(token);
        }
        for (const mutation of element.mutations) {
          if (mutation.attribute === "class") {
            for (const token of mutation.toggledClassTokens) toggledClasses.add(token);
          } else if (mutation.count > 0) toggledAttributes.add(mutation.attribute);
        }
      }
      for (const token of toggledClasses)
        count(capMarkup(`class:${token}`), "class", "toggle", active, tileKey);
      for (const name of toggledAttributes)
        count(capMarkup(`attr:${name}`), "attribute", "toggle", active, tileKey);
      for (const token of present) count(capMarkup(`class:${token}`), "class", "presence", active, tileKey);
    }
  }

  const qualifying: Q2Indicator[] = [];
  for (const tally of tallies.values()) {
    const speechBase = tally.measure === "toggle" ? activeSamplesWithTiles : activeTileSamples;
    const silenceBase = tally.measure === "toggle" ? quietSamplesWithTiles : quietTileSamples;
    const speechRate = share(tally.speech, speechBase);
    const silenceRate = share(tally.silence, silenceBase);
    if (tally.speech < MIN_AUDIO_ACTIVE_SAMPLES || speechRate < SPEAKING_TOGGLE_RATIO * silenceRate) continue;
    qualifying.push({
      name: tally.name,
      kind: tally.kind,
      measure: tally.measure,
      speech: tally.speech,
      silence: tally.silence,
      speechRate: round3(speechRate),
      silenceRate: round3(silenceRate),
      tiles: tally.tiles.size,
    });
  }
  qualifying.sort(
    (a, b) =>
      b.tiles - a.tiles ||
      b.speechRate - b.silenceRate - (a.speechRate - a.silenceRate) ||
      a.name.localeCompare(b.name)
  );
  const counts: Q2Counts = {
    activeSamplesWithTiles,
    quietSamplesWithTiles,
    activeTileSamples,
    quietTileSamples,
    candidates: candidates.size,
    qualifying: qualifying.length,
    indicators: qualifying.slice(0, MAX_REPORTED_INDICATORS),
  };
  const verdict = (kind: MeasurementVerdict["verdict"], evidence: string): MeasurementVerdict => ({
    id: "Q2",
    verdict: kind,
    evidence,
    counts,
  });

  if (speechSamples.length === 0)
    return verdict("inconclusive", "Not judged: no page samples were collected.");
  if (activeSamplesWithTiles < MIN_AUDIO_ACTIVE_SAMPLES || quietSamplesWithTiles < MIN_AUDIO_ACTIVE_SAMPLES) {
    return verdict(
      "inconclusive",
      `Not judged: ${activeSamplesWithTiles} samples with speech and ${quietSamplesWithTiles} quiet samples held a tile (${MIN_AUDIO_ACTIVE_SAMPLES} of each needed to compare).`
    );
  }
  if (counts.qualifying > 0) {
    return verdict(
      "supported",
      `${counts.qualifying} of ${counts.candidates} tile indicators follow speech at least ${SPEAKING_TOGGLE_RATIO} times as often as silence: ${describeIndicators(counts.indicators)}.`
    );
  }
  return verdict(
    "excluded",
    `None of ${counts.candidates} class tokens and attributes followed speech at least ${SPEAKING_TOGGLE_RATIO} times as often as silence, over ${activeSamplesWithTiles} samples with speech and ${quietSamplesWithTiles} quiet samples.`
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const low = sorted[middle - 1] ?? 0;
  const high = sorted[middle] ?? 0;
  return Math.round(sorted.length % 2 === 1 ? high : (low + high) / 2);
}

function judgeQ3(speechSamples: SpeechSample[]): MeasurementVerdict {
  const entries = speechSamples.flatMap((item) => item.entries);
  const judged = entries.filter((item) => item.speech);
  const ages = judged.flatMap((item) => (item.entry.ageMs === null ? [] : [Math.round(item.entry.ageMs)]));
  const withinTolerance = judged.filter(
    (item) => item.entry.ageMs !== null && Math.abs(item.entry.ageMs) <= SOURCE_CLOCK_TOLERANCE_MS
  ).length;
  const counts: Q3Counts = {
    entriesWithTimestamp: entries.filter((item) => item.entry.timestampRaw !== null).length,
    judgedEntries: judged.length,
    withinTolerance,
    outsideTolerance: judged.length - withinTolerance,
    medianAgeMs: median(ages),
    minAgeMs: ages.length === 0 ? null : Math.min(...ages),
    maxAgeMs: ages.length === 0 ? null : Math.max(...ages),
  };
  const verdict = (kind: MeasurementVerdict["verdict"], evidence: string): MeasurementVerdict => ({
    id: "Q3",
    verdict: kind,
    evidence,
    counts,
  });
  const agreement = share(withinTolerance, judged.length);
  const numbers = `${withinTolerance} of ${judged.length} entries that carried speech were within ${SOURCE_CLOCK_TOLERANCE_MS} ms of the page clock, median age ${counts.medianAgeMs === null ? "unknown" : ms(counts.medianAgeMs)}`;

  if (speechSamples.length === 0)
    return verdict("inconclusive", "Not judged: no page samples were collected.");
  if (judged.length < MIN_AUDIO_ACTIVE_SAMPLES) {
    return verdict(
      "inconclusive",
      `Not judged: only ${judged.length} source entries carried fresh speech (${MIN_AUDIO_ACTIVE_SAMPLES} needed).`
    );
  }
  if (agreement >= CLOCK_AGREEMENT_SHARE) return verdict("supported", `${capitalise(numbers)}.`);
  if (agreement <= 1 - CLOCK_AGREEMENT_SHARE) return verdict("excluded", `${capitalise(numbers)}.`);
  return verdict("inconclusive", `Mixed: ${numbers}.`);
}

// Only observation samples are judged; the pre-leave and after-leave samples come after the speech schedule.
export function evaluateMeasurements(samples: readonly ReportSample[]): MeasurementVerdict[] {
  const speechSamples = toSpeechSamples(samples);
  return [judgeQ1(speechSamples), judgeQ2(speechSamples), judgeQ3(speechSamples)];
}

// ---- Summary ----

const MEASUREMENTS: readonly { id: MeasurementVerdict["id"]; title: string }[] = [
  { id: "Q1", title: "tile source equals a receiver source that rises with speech" },
  { id: "Q2", title: "a per-tile indicator follows speech" },
  { id: "Q3", title: "source timestamps are on the page clock" },
];

function summaryLines(prefix: "L" | "S", verdicts: HypothesisVerdict[]): string[] {
  return HYPOTHESES.filter(({ id }) => id.startsWith(prefix)).map(({ id, title }) => {
    const verdict = verdicts.find((entry) => entry.id === id);
    const status = (verdict ? verdict.verdict : "not evaluated").padEnd(13);
    return `  ${id}  ${status} ${title}${verdict ? `: ${verdict.evidence}` : ""}`;
  });
}

function measurementLines(measurements: MeasurementVerdict[]): string[] {
  return MEASUREMENTS.map(({ id, title }) => {
    const measurement = measurements.find((entry) => entry.id === id);
    const status = (measurement ? measurement.verdict : "not evaluated").padEnd(13);
    return `  ${id}  ${status} ${title}${measurement ? `: ${measurement.evidence}` : ""}`;
  });
}

export function formatSummary(
  verdicts: HypothesisVerdict[],
  outFile: string,
  measurements: MeasurementVerdict[] = []
): string {
  return [
    "Meet probe summary",
    "",
    "Leave",
    ...summaryLines("L", verdicts),
    "",
    "Speakers",
    ...summaryLines("S", verdicts),
    "",
    ...(measurements.length > 0 ? ["Speech measurement", ...measurementLines(measurements), ""] : []),
    `File to send back: ${outFile}`,
    "Before sending it, search the file for participant names and the meeting code; neither may be in it.",
    "",
  ].join("\n");
}
