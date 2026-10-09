// Turns what a Meet probe run collected into the JSON the owner sends back and into verdicts on the hypotheses
// about the two open defects (the leave click failing, speakers never being named). Pure: no I/O, no clock.

import { DRIVER_LEAVE_TIMEOUT_MS } from "../src/platform/browser/BrowserPlatformAdapter";
import { GOOGLE_MEET_SELECTORS } from "../src/platform/GoogleMeetAdapter";
import type { PlatformEvent } from "../src/platform/PlatformAdapter";
import { NameRedactor } from "./meetProbeRedaction";
import type {
  HypothesisId,
  HypothesisVerdict,
  MeetSelectorKey,
  ProbeOutcome,
  ProbeReport,
  RawAdapterLogLine,
  RawElementFacts,
  RawLocatedString,
  RawPageSample,
  RawProbeRun,
  RawRtcSourceEntry,
  RawSelectorCheck,
  RecordedPageCall,
  ReportElementFacts,
  ReportPlatformEvent,
  ReportSample,
  ReportTimelineEntry,
  SelectorSweepResult,
} from "./meetProbeTypes";

export const MEET_PROBE_REPORT_VERSION = 1;

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
];
const SAMPLE_CLOCK_LIMIT =
  "Sample tMs is the time the sample was received; after-leave samples and samples without a receipt carry pageTimeMs instead, which restarts in each new document.";

export type ProbeSampleReceipt = { tMs: number; sequence: number };
export type BuildProbeReportOptions = { redactNames: boolean; sampleReceipts: readonly ProbeSampleReceipt[] };

type TileKeys = { keyOf(participantId: string): string; has(participantId: string): boolean };

function createTileKeys(): TileKeys {
  const keys = new Map<string, string>();
  return {
    keyOf(participantId) {
      const known = keys.get(participantId);
      if (known) return known;
      const key = `tile-${keys.size + 1}`;
      keys.set(participantId, key);
      return key;
    },
    has: (participantId) => keys.has(participantId),
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
      tileKey: tileKeys.keyOf(tile.participantId),
      classTokens: tile.classTokens.map(capMarkup),
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
    rtc: sample.rtc,
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
      const tileKey = tileKeys.keyOf(tile.participantId);
      for (const entry of tile.strings) {
        if (isLearnedWhole(entry)) redactor.learnName(entry.value, entry.where, tileKey);
      }
    }
  }
  for (const sample of samples) {
    for (const tile of sample.tiles) {
      const tileKey = tileKeys.keyOf(tile.participantId);
      for (const entry of tile.strings) {
        if (!isLearnedWhole(entry)) redactor.learnTileString(entry.value, entry.where, tileKey);
      }
    }
  }
}

function createParticipantIdMapper(
  tileKeys: TileKeys,
  redactor: NameRedactor
): (participantId: string) => string {
  const otherKeys = new Map<string, string>();
  return (participantId) => {
    const idName = nameOfParticipantId(participantId);
    if (idName !== null) return `${NAME_ID_PREFIX}${redactor.redactOtherString(idName)}`;
    if (tileKeys.has(participantId)) return tileKeys.keyOf(participantId);
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
  redactor: NameRedactor
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
      return { tMs, type: event.type, sourceKey: event.sourceKey, level: event.level };
    case "source_identity":
      return {
        tMs,
        type: event.type,
        sourceKey: event.sourceKey,
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

function buildTimeline(report: Omit<ProbeReport, "timeline" | "hypotheses">): ReportTimelineEntry[] {
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
    for (const tile of sample.tiles) tileKeys.keyOf(tile.participantId);
  }
  learnNames(raw, everySample, tileKeys, redactor);

  // The page clock restarts in each new document, so a sample's time on the probe clock is its receipt time.
  const toSample = (sample: RawPageSample, tMs: number = sample.pageTimeMs): ReportSample =>
    toReportSample(sample, tMs, tileKeys, redactor);
  const mapParticipantId = createParticipantIdMapper(tileKeys, redactor);

  const withoutVerdicts: Omit<ProbeReport, "timeline" | "hypotheses"> = {
    schemaVersion: 1,
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
      flattenEvent(tMs, event, mapParticipantId, redactor)
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
  };
  report.hypotheses = evaluateHypotheses(report);
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
  const activeSources = new Set(entries.filter(isActiveEntry).map((entry) => entry.source)).size;
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

// ---- Summary ----

function summaryLines(prefix: "L" | "S", verdicts: HypothesisVerdict[]): string[] {
  return HYPOTHESES.filter(({ id }) => id.startsWith(prefix)).map(({ id, title }) => {
    const verdict = verdicts.find((entry) => entry.id === id);
    const status = (verdict ? verdict.verdict : "not evaluated").padEnd(13);
    return `  ${id}  ${status} ${title}${verdict ? `: ${verdict.evidence}` : ""}`;
  });
}

export function formatSummary(verdicts: HypothesisVerdict[], outFile: string): string {
  return [
    "Meet probe summary",
    "",
    "Leave",
    ...summaryLines("L", verdicts),
    "",
    "Speakers",
    ...summaryLines("S", verdicts),
    "",
    `File to send back: ${outFile}`,
    "Before sending it, search the file for participant names and the meeting code; neither may be in it.",
    "",
  ].join("\n");
}
