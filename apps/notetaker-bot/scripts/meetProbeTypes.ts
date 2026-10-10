// Types only. This is the contract between the in-page collector, the redactor, the recorder, the report builder
// and the CLI plan of the Meet probe. Nothing here may hold audio samples, chat text, the meeting URL or a credential.

import type { GOOGLE_MEET_SELECTORS } from "../src/platform/GoogleMeetAdapter";
import type { PlatformEvent } from "../src/platform/PlatformAdapter";

export type MeetSelectorKey = keyof typeof GOOGLE_MEET_SELECTORS;

export type ProbeJoinMode = "guest" | "account";
export type ProbeCredentialRoute = "guest" | "storage_state" | "password";

// Where a string was found on the page. Redaction reports it so the speaker hypotheses can tell label from text.
export type StringLocation = "text" | "aria-label" | "title" | "tooltip";

// ---- In-page collection (everything below is posted through the exposeBinding route) ----

export type RawBox = {
  width: number;
  height: number;
  inViewport: boolean;
};

export type RawHitTest = "self" | "descendant" | "other" | "none";

export type RawStyleFacts = {
  display: string;
  visibility: string;
  opacity: string;
  pointerEvents: string;
};

// A leave-like control found by the discovery nets. Never clicked.
export type RawElementFacts = {
  tag: string;
  role: string | null;
  ariaLabel: string | null;
  title: string | null;
  tooltip: string | null;
  text: string | null;
  dataAttributeNames: string[];
  // Values of aria-pressed, aria-expanded, aria-disabled, aria-hidden and similar state attributes, keyed by name.
  ariaStates: Record<string, string>;
  disabled: boolean;
  // null when the element has no layout box.
  box: RawBox | null;
  style: RawStyleFacts;
  hitTest: RawHitTest;
  // Tag and role of the element at the box centre when hitTest is "other"; null otherwise.
  coveredBy: { tag: string; role: string | null; ariaLabel: string | null } | null;
  inDialog: boolean;
  // Which discovery nets matched, e.g. "aria-label*=leave", "title*=hang", "text:leave".
  matchedBy: string[];
};

export type RawLocatedString = {
  value: string;
  where: StringLocation;
  visible: boolean;
  // True for a span.notranslate, the element the adapter reads names from.
  isNotranslateSpan: boolean;
};

export type RawAttributeMutation = {
  attribute: string;
  // Mutations of this attribute inside the tile since the previous sample.
  count: number;
  // Class tokens added or removed since the previous sample; empty unless the attribute is "class".
  toggledClassTokens: string[];
};

// 16 lower-case hex characters: a salted SHA-256 prefix made in the page. The raw value never leaves the page.
export type ProbeHash = string;

export type RawClassTokenChanges = {
  added: string[];
  removed: string[];
};

// An outermost [data-participant-id] element. The id is hashed in the page and Node maps the hash to "tile-N".
export type RawTileFacts = {
  participantIdHash: ProbeHash;
  // Hashes of the distinct data-ssrc values on the tile and its descendants.
  sourceHashes: ProbeHash[];
  classTokens: string[];
  // Class tokens gained or lost since the previous sample of the same element; empty on first sight.
  classTokenChanges: RawClassTokenChanges;
  strings: RawLocatedString[];
  dataAttributeNames: string[];
  ariaStates: Record<string, string>;
  mutations: RawAttributeMutation[];
  // Total mutations of any kind inside the tile since the previous sample.
  mutationCount: number;
};

// One decomposed part of the adapter's speaker selector, counted in the page.
export type RawSelectorCheck = {
  selector: string;
  matched: number;
  visible: number;
};

export type RawRtcSourceEntry = {
  sourceHash: ProbeHash;
  // 0..1 as the browser reports it; null when the entry carries none.
  audioLevel: number | null;
  // Milliseconds between the entry's timestamp and the sample time; null when unusable.
  ageMs: number | null;
  // The timestamp exactly as the browser returned it, to expose the clock scale.
  timestampRaw: number | null;
};

export type RawRtcReceiverFacts = {
  readyState: string;
  muted: boolean;
  contributingSources: RawRtcSourceEntry[];
  synchronizationSources: RawRtcSourceEntry[];
};

export type RawRtcFacts = {
  peerConnectionCount: number;
  receivers: RawRtcReceiverFacts[];
};

export type RawDialogFacts = {
  ariaLabel: string | null;
  role: string | null;
};

export type RawPageSample = {
  // Increases by one per sample; Node waits for the next one by this number.
  sequence: number;
  // Milliseconds since the collector was installed in this page.
  pageTimeMs: number;
  leaveControls: RawElementFacts[];
  tiles: RawTileFacts[];
  selectorChecks: RawSelectorCheck[];
  rtc: RawRtcFacts;
  visibilityState: string;
  hasFocus: boolean;
  dialogCount: number;
  dialogs: RawDialogFacts[];
};

// ---- Recorder ----

export type RecordedPageMethod =
  | "goto"
  | "currentUrl"
  | "isVisible"
  | "waitForVisible"
  | "click"
  | "fill"
  | "pressKey"
  | "readText"
  | "readTexts"
  | "waitForVisibleInAnyFrame"
  | "clickInAnyFrame"
  | "fillInAnyFrame"
  | "readValueInAnyFrame"
  | "addInitScript"
  | "exposeBinding"
  | "onClosed"
  | "close";

// Results are counts or booleans only: never a text, a value filled or a URL.
export type RecordedPageResult =
  | { kind: "void" }
  | { kind: "boolean"; value: boolean }
  | { kind: "count"; value: number }
  // readText and readValueInAnyFrame: whether the first match existed.
  | { kind: "found"; value: boolean };

export type RecordedPageCall = {
  // Milliseconds since the probe started.
  tMs: number;
  method: RecordedPageMethod;
  // The adapter selector key the call used; null when the selector is not one of GOOGLE_MEET_SELECTORS.
  selectorKey: MeetSelectorKey | null;
  // null when the call threw.
  result: RecordedPageResult | null;
  // Class name of the thrown error; null when the call succeeded.
  errorName: string | null;
  durationMs: number;
};

export type SelectorSweepResult = {
  tMs: number;
  selectorKey: MeetSelectorKey;
  matched: number;
  visible: number;
};

// ---- Redaction ----

export type NameAliasSummary = {
  alias: string;
  // Where the name appeared; the raw name is never kept.
  locations: StringLocation[];
  // Number of tiles it appeared in.
  tileCount: number;
  // Whether a speaker event carried it.
  inSpeakerEvents: boolean;
};

// ---- Options ----

// What the in-page collector needs to run.
export type MeetProbePageOptions = {
  intervalMs: number;
  // 64 lower-case hex characters, random per run; never written anywhere.
  salt: string;
  // Redaction happens in Node; the page always sends raw strings.
  maxLeaveControls: number;
  maxTiles: number;
  maxStringsPerTile: number;
  maxStringLength: number;
};

export type MeetProbeOptions = {
  // Held in memory only; checked for leaks and never written.
  meetingUrl: string;
  // Absolute path; must not exist.
  outFile: string;
  durationSeconds: number;
  intervalMs: number;
  admitTimeoutSeconds: number;
  redactNames: boolean;
  postNotice: boolean;
  help: boolean;
};

// ---- Raw run handed to buildProbeReport ----

export type ProbeOutcome =
  | "completed"
  | "interrupted"
  | "denied"
  | "removed"
  | "meeting_ended"
  | "connection_lost"
  | "admit_timeout"
  | "join_failed";

export type ProbeNoticeStatus = "posted" | "skipped" | "failed";

export type RawRunMetadata = {
  startedAt: string;
  outcome: ProbeOutcome;
  joinMode: ProbeJoinMode;
  credentialRoute: ProbeCredentialRoute;
  chromeChannel: string;
  headless: boolean;
  platform: string;
  nodeVersion: string;
  // Host of the meeting URL only, e.g. "meet.google.com".
  meetingHost: string;
  notice: ProbeNoticeStatus;
  // The real run length, which is shorter than the requested one after an early end.
  observedMs: number;
};

export type RawPlatformEvent = {
  // Milliseconds since the probe started, taken on receipt.
  tMs: number;
  event: PlatformEvent;
};

export type RawAudioCounters = {
  frames: number;
  nonSilentFrames: number;
};

export type RawAdapterLogLine = {
  tMs: number;
  level: string;
  message: string;
  // Context fields the adapter logged, already free of URL, name, text and credential by the adapter's own rule.
  fields: Record<string, string | number | boolean | null>;
};

export type RawLeaveStep = {
  tMs: number;
  // Short fixed labels such as "pre-leave", "adapter.leave", "after-leave"; never page text.
  label: string;
  durationMs: number | null;
};

export type RawAfterLeaveObservation = {
  // Up to 3 s of observation on the inner page just before the real close.
  observedMs: number;
  endedTextVisible: boolean;
  leaveCallButtonVisible: boolean;
  inMeetingMarkerVisible: boolean;
  // Dialog selector keys currently visible.
  dialogKeysVisible: MeetSelectorKey[];
  // Kind of the final URL only.
  urlKind: "meeting" | "other" | "blank";
  // Milliseconds from the leave click until the ended text first showed; null if it never did.
  msFromClickToEndedText: number | null;
  samples: RawPageSample[];
};

export type RawLeaveRecord = {
  preLeave: {
    tMs: number;
    sweeps: SelectorSweepResult[];
    sample: RawPageSample | null;
  };
  steps: RawLeaveStep[];
  adapterLog: RawAdapterLogLine[];
  afterLeave: RawAfterLeaveObservation | null;
  elapsedMs: number;
};

export type RawProbeRun = {
  options: MeetProbeOptions;
  run: RawRunMetadata;
  samples: RawPageSample[];
  selectorSweeps: SelectorSweepResult[];
  platformEvents: RawPlatformEvent[];
  audio: RawAudioCounters;
  pageCalls: RecordedPageCall[];
  leave: RawLeaveRecord;
};

// ---- Written report (schemaVersion 2) ----

export type HypothesisId =
  | "L1"
  | "L2"
  | "L3"
  | "L4"
  | "L5"
  | "L6"
  | "S1"
  | "S2"
  | "S3"
  | "S4"
  | "S5"
  | "S6"
  | "S7";

export type HypothesisVerdict = {
  id: HypothesisId;
  verdict: "supported" | "excluded" | "inconclusive";
  // One sentence.
  evidence: string;
};

// Strings in the report are redacted unless redactNames is false.
export type ReportElementFacts = Omit<RawElementFacts, "ariaLabel" | "title" | "tooltip" | "text"> & {
  ariaLabel: string | null;
  title: string | null;
  tooltip: string | null;
  text: string | null;
};

export type ReportTileFacts = {
  // "tile-1", "tile-2", ... in order of first sight; the raw participant id is never written.
  tileKey: string;
  participantIdHash: ProbeHash;
  sourceHashes: ProbeHash[];
  classTokens: string[];
  classTokenChanges: RawClassTokenChanges;
  strings: RawLocatedString[];
  dataAttributeNames: string[];
  ariaStates: Record<string, string>;
  mutations: RawAttributeMutation[];
  mutationCount: number;
};

export type ReportSample = {
  sequence: number;
  tMs: number;
  pageTimeMs: number;
  leaveControls: ReportElementFacts[];
  tiles: ReportTileFacts[];
  selectorChecks: RawSelectorCheck[];
  rtc: RawRtcFacts;
  visibilityState: string;
  hasFocus: boolean;
  dialogCount: number;
  dialogs: RawDialogFacts[];
};

export type ReportPlatformEvent = {
  tMs: number;
  type: PlatformEvent["type"];
  // Present only on the event types that carry them; names are aliased when redaction is on.
  participantId?: string;
  name?: string;
  speaking?: boolean;
  count?: number;
  sourceKey?: string;
  level?: number;
};

// A compact per-moment view across channels, so the hypotheses can be read against one clock.
export type ReportTimelineEntry = {
  tMs: number;
  kind: "event" | "sample" | "sweep" | "call" | "leave";
  summary: string;
};

export type ReportSelectorInfo = {
  // Selector key to its Playwright selector string, for the keys the probe swept.
  swept: Record<string, string>;
  // The decomposed in-page checks, so a reader can see which part of the speaker selector fails.
  decomposed: string[];
  // Known limits of what the probe can see, e.g. the approximated accessible tree.
  limits: string[];
};

export type MeasurementId = "Q1" | "Q2" | "Q3";
export type SourceKind = "csrc" | "ssrc";

export type Q1Counts = {
  samples: number;
  activeSamples: number;
  activeSamplesWithTiles: number;
  tilesSeen: number;
  tilesWithSource: number;
  receiverSources: Record<SourceKind, number>;
  linkedTiles: number;
  matchedEntries: Record<SourceKind, number>;
  soloSamplesByTile: Record<string, number>;
  tilesWithSoloSpeech: number;
  multiActiveSamples: number;
  unlinkedActiveSamples: number;
};

export type Q2Indicator = {
  name: string;
  kind: "class" | "attribute";
  measure: "toggle" | "presence";
  speech: number;
  silence: number;
  speechRate: number;
  silenceRate: number;
  tiles: number;
};

export type Q2Counts = {
  activeSamplesWithTiles: number;
  quietSamplesWithTiles: number;
  activeTileSamples: number;
  quietTileSamples: number;
  candidates: number;
  qualifying: number;
  indicators: Q2Indicator[];
};

export type Q3Counts = {
  entriesWithTimestamp: number;
  judgedEntries: number;
  withinTolerance: number;
  outsideTolerance: number;
  medianAgeMs: number | null;
  minAgeMs: number | null;
  maxAgeMs: number | null;
};

export type MeasurementBase = { verdict: HypothesisVerdict["verdict"]; evidence: string };
export type MeasurementVerdict =
  | (MeasurementBase & { id: "Q1"; counts: Q1Counts })
  | (MeasurementBase & { id: "Q2"; counts: Q2Counts })
  | (MeasurementBase & { id: "Q3"; counts: Q3Counts });

export type ProbeReport = {
  schemaVersion: 2;
  tool: { name: "meet-probe"; version: number };
  run: {
    startedAt: string;
    durationSeconds: number;
    intervalMs: number;
    redactNames: boolean;
    outcome: ProbeOutcome;
    joinMode: ProbeJoinMode;
    credentialRoute: ProbeCredentialRoute;
    chrome: { channel: string; headless: boolean };
    platform: string;
    nodeVersion: string;
    // Only the host: the meeting URL and code are never written.
    meeting: { host: string };
    notice: ProbeNoticeStatus;
    observedMs: number;
  };
  selectors: ReportSelectorInfo;
  timeline: ReportTimelineEntry[];
  samples: ReportSample[];
  selectorSweeps: SelectorSweepResult[];
  platformEvents: ReportPlatformEvent[];
  audio: RawAudioCounters;
  pageCalls: RecordedPageCall[];
  leave: {
    preLeave: {
      tMs: number;
      sweeps: SelectorSweepResult[];
      sample: ReportSample | null;
    };
    steps: RawLeaveStep[];
    adapterLog: RawAdapterLogLine[];
    afterLeave:
      | (Omit<RawAfterLeaveObservation, "samples"> & {
          samples: ReportSample[];
        })
      | null;
    elapsedMs: number;
  };
  names: NameAliasSummary[];
  hypotheses: HypothesisVerdict[];
  measurements: MeasurementVerdict[];
};
