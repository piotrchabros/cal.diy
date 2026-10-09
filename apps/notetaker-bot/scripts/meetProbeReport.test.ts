// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { PlatformEvent } from "../src/platform/PlatformAdapter";
import {
  AUDIO_ACTIVE_LEVEL,
  buildProbeReport,
  evaluateHypotheses,
  formatSummary,
  LEAVE_REGISTER_FAST_MS,
  MAX_MARKUP_STRING_LENGTH,
  MIN_AUDIO_ACTIVE_SAMPLES,
  type ProbeSampleReceipt,
} from "./meetProbeReport";
import type {
  HypothesisId,
  HypothesisVerdict,
  MeetSelectorKey,
  ProbeReport,
  RawAfterLeaveObservation,
  RawElementFacts,
  RawLeaveRecord,
  RawLocatedString,
  RawPageSample,
  RawPlatformEvent,
  RawProbeRun,
  RawRtcSourceEntry,
  RawSelectorCheck,
  RawTileFacts,
  RecordedPageCall,
  SelectorSweepResult,
} from "./meetProbeTypes";

const MEETING_CODE = "abc-defg-hij";
const ZOFIA = "Zofia Wrona";
const BOGDAN = "Bogdan Kruk";
const ZOFIA_ID = "spaces/q1/devices/111";
const BOGDAN_ID = "spaces/q1/devices/222";
const LATE_ID = "spaces/q1/devices/333";
const RAW_SECRETS = ["Zofia", "Wrona", "Bogdan", "Kruk"];
const RAW_IDS = [ZOFIA_ID, BOGDAN_ID, LATE_ID];

const TILE_SPEAKING = '[data-participant-id]:has([aria-label*="speaking" i])';
const ANY_SPEAKING = '[aria-label*="speaking" i]';
const TILE_NAME_SPAN = "[data-participant-id] span.notranslate";

const LEAVE_WARNING = "leave control not visible; leaving by closing the page";

const ALL_IDS: HypothesisId[] = [
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
];

const source = (id: number, audioLevel: number | null, ageMs: number | null = 20): RawRtcSourceEntry => ({
  source: id,
  audioLevel,
  ageMs,
  timestampRaw: 1000,
});

const rtc = (entries: RawRtcSourceEntry[], receivers = 1): RawPageSample["rtc"] => ({
  peerConnectionCount: 1,
  receivers: Array.from({ length: receivers }, (_, index) => ({
    readyState: "live",
    muted: false,
    contributingSources: index === 0 ? entries : [],
    synchronizationSources: [],
  })),
});

const check = (selector: string, matched: number, visible = matched): RawSelectorCheck => ({
  selector,
  matched,
  visible,
});

const located = (
  value: string,
  where: RawLocatedString["where"],
  isNotranslateSpan = false
): RawLocatedString => ({ value, where, visible: true, isNotranslateSpan });

const tile = (participantId: string, overrides: Partial<RawTileFacts> = {}): RawTileFacts => ({
  participantId,
  classTokens: ["oZRSLe"],
  strings: [],
  dataAttributeNames: ["data-participant-id"],
  ariaStates: {},
  mutations: [],
  mutationCount: 0,
  ...overrides,
});

const control = (overrides: Partial<RawElementFacts> = {}): RawElementFacts => ({
  tag: "button",
  role: null,
  ariaLabel: "Leave call",
  title: null,
  tooltip: null,
  text: null,
  dataAttributeNames: [],
  ariaStates: {},
  disabled: false,
  box: { width: 56, height: 40, inViewport: true },
  style: { display: "inline-flex", visibility: "visible", opacity: "1", pointerEvents: "auto" },
  hitTest: "self",
  coveredBy: null,
  inDialog: false,
  matchedBy: ["aria-label*=leave"],
  ...overrides,
});

const sample = (sequence: number, overrides: Partial<RawPageSample> = {}): RawPageSample => ({
  sequence,
  pageTimeMs: sequence * 1000,
  leaveControls: [],
  tiles: [],
  selectorChecks: [],
  rtc: rtc([]),
  visibilityState: "visible",
  hasFocus: true,
  dialogCount: 0,
  dialogs: [],
  ...overrides,
});

const samples = (count: number, build: (sequence: number) => Partial<RawPageSample>, from = 1) =>
  Array.from({ length: count }, (_, index) => sample(from + index, build(from + index)));

const sweep = (
  selectorKey: MeetSelectorKey,
  matched: number,
  visible: number,
  tMs = 1000
): SelectorSweepResult => ({ tMs, selectorKey, matched, visible });

const event = (tMs: number, platformEvent: PlatformEvent): RawPlatformEvent => ({
  tMs,
  event: platformEvent,
});

const speaker = (tMs: number, name: string, speaking: boolean): RawPlatformEvent =>
  event(tMs, { type: "speaker", participantId: `name:${name}`, name, speaking });

const call = (
  method: RecordedPageCall["method"],
  selectorKey: MeetSelectorKey | null,
  overrides: Partial<RecordedPageCall> = {}
): RecordedPageCall => ({
  tMs: 61000,
  method,
  selectorKey,
  result: method === "isVisible" ? { kind: "boolean", value: true } : { kind: "void" },
  errorName: null,
  durationMs: 10,
  ...overrides,
});

const afterLeave = (overrides: Partial<RawAfterLeaveObservation> = {}): RawAfterLeaveObservation => ({
  observedMs: 3000,
  endedTextVisible: true,
  leaveCallButtonVisible: false,
  inMeetingMarkerVisible: false,
  dialogKeysVisible: [],
  urlKind: "meeting",
  msFromClickToEndedText: 400,
  samples: [],
  ...overrides,
});

const leave = (overrides: Partial<RawLeaveRecord> = {}): RawLeaveRecord => ({
  preLeave: { tMs: 60000, sweeps: [sweep("leaveCallButton", 1, 1, 60000)], sample: null },
  steps: [
    { tMs: 60000, label: "pre-leave", durationMs: 50 },
    { tMs: 61000, label: "adapter.leave", durationMs: 200 },
  ],
  adapterLog: [],
  afterLeave: afterLeave(),
  elapsedMs: 3500,
  ...overrides,
});

const rawRun = (overrides: Partial<RawProbeRun> = {}): RawProbeRun => ({
  options: {
    meetingUrl: `https://meet.google.com/${MEETING_CODE}`,
    outFile: "/tmp/meet-probe.json",
    durationSeconds: 60,
    intervalMs: 1000,
    admitTimeoutSeconds: 300,
    redactNames: true,
    postNotice: true,
    help: false,
  },
  run: {
    startedAt: "2030-01-01T10:00:00.000Z",
    outcome: "completed",
    joinMode: "account",
    credentialRoute: "storage_state",
    chromeChannel: "chrome",
    headless: false,
    platform: "linux",
    nodeVersion: "v20.0.0",
    meetingHost: "meet.google.com",
    notice: "posted",
    observedMs: 60000,
  },
  samples: [],
  selectorSweeps: [],
  platformEvents: [],
  audio: { frames: 0, nonSilentFrames: 0 },
  pageCalls: [],
  leave: leave(),
  ...overrides,
});

const LEAVE_CALLS_OK = [
  call("isVisible", "leaveCallButton"),
  call("click", "leaveCallButton", { tMs: 61020, durationMs: 120 }),
];

const build = (
  raw: RawProbeRun,
  redactNames = true,
  sampleReceipts: readonly ProbeSampleReceipt[] = []
): ProbeReport => buildProbeReport(raw, { redactNames, sampleReceipts });

const verdictOf = (raw: RawProbeRun, id: HypothesisId): HypothesisVerdict => {
  const verdict = build(raw).hypotheses.find((entry) => entry.id === id);
  if (!verdict) throw new Error(`Unable to read the verdict: hypothesis ${id} is missing from the report`);
  return verdict;
};

const talking = (id: number, level = 0.4) => rtc([source(id, level)]);

describe("buildProbeReport: shape", () => {
  it("carries the run facts and only the meeting host", () => {
    const report = build(rawRun());

    expect(report.schemaVersion).toBe(1);
    expect(report.tool).toEqual({ name: "meet-probe", version: 1 });
    expect(report.run).toEqual({
      startedAt: "2030-01-01T10:00:00.000Z",
      durationSeconds: 60,
      intervalMs: 1000,
      redactNames: true,
      outcome: "completed",
      joinMode: "account",
      credentialRoute: "storage_state",
      chrome: { channel: "chrome", headless: false },
      platform: "linux",
      nodeVersion: "v20.0.0",
      meeting: { host: "meet.google.com" },
      notice: "posted",
      observedMs: 60000,
    });
    expect(JSON.stringify(report)).not.toContain(MEETING_CODE);
    expect(JSON.stringify(report)).not.toContain("/tmp/meet-probe.json");
  });

  it("takes redactNames from its own option, not from the parsed arguments", () => {
    expect(build(rawRun(), false).run.redactNames).toBe(false);
  });

  it("is deterministic", () => {
    const raw = rawRun({ samples: samples(3, () => ({ rtc: talking(7) })), pageCalls: LEAVE_CALLS_OK });

    expect(build(raw)).toEqual(build(raw));
  });

  it("carries sweeps, page calls, audio counters and the leave record", () => {
    const raw = rawRun({
      selectorSweeps: [sweep("activeSpeakerName", 0, 0), sweep("chatButton", 1, 1)],
      pageCalls: LEAVE_CALLS_OK,
      audio: { frames: 40, nonSilentFrames: 12 },
    });
    const report = build(raw);

    expect(report.selectorSweeps).toEqual(raw.selectorSweeps);
    expect(report.pageCalls).toEqual(raw.pageCalls);
    expect(report.audio).toEqual({ frames: 40, nonSilentFrames: 12 });
    expect(report.leave.steps).toEqual(raw.leave.steps);
    expect(report.leave.elapsedMs).toBe(3500);
    expect(report.leave.afterLeave?.msFromClickToEndedText).toBe(400);
    expect(Object.keys(report.selectors.swept)).toEqual([
      "activeSpeakerName",
      "chatButton",
      "leaveCallButton",
    ]);
    expect(report.selectors.swept.leaveCallButton).toContain("Leave call");
  });

  it("lists the five decomposed in-page selectors and states the limits", () => {
    const raw = rawRun({
      samples: samples(2, () => ({ selectorChecks: [check(TILE_SPEAKING, 0), check(ANY_SPEAKING, 0)] })),
    });
    const report = build(raw);

    expect(report.selectors.decomposed).toEqual([
      "[data-participant-id]",
      TILE_SPEAKING,
      ANY_SPEAKING,
      TILE_NAME_SPAN,
      "span.notranslate",
    ]);
    expect(report.selectors.limits.join(" ")).toContain("approximated");
    expect(report.selectors.limits.join(" ")).toContain("pageTimeMs");
  });

  it("stamps samples with their receipt time by index and falls back to page time", () => {
    const raw = rawRun({
      samples: [sample(1), sample(2), sample(1)],
      leave: leave({
        preLeave: { tMs: 60000, sweeps: [], sample: sample(50) },
        afterLeave: afterLeave({ samples: [sample(51)] }),
      }),
    });
    const report = build(raw, true, [
      { tMs: 4100, sequence: 1 },
      { tMs: 5100, sequence: 2 },
    ]);

    expect(report.samples.map((entry) => [entry.tMs, entry.pageTimeMs])).toEqual([
      [4100, 1000],
      [5100, 2000],
      [1000, 1000],
    ]);
    expect(report.leave.preLeave.sample).toMatchObject({ tMs: 60000, pageTimeMs: 50000 });
    expect(report.leave.afterLeave?.samples[0]).toMatchObject({ tMs: 51000, pageTimeMs: 51000 });
  });

  it("flattens platform events and keeps only the fields each type carries", () => {
    const raw = rawRun({
      platformEvents: [
        event(100, { type: "admitted" }),
        event(200, { type: "participant_count", count: 3 }),
        event(300, { type: "source_activity", sourceKey: "csrc:7", level: 0.5 }),
      ],
    });

    expect(build(raw).platformEvents).toEqual([
      { tMs: 100, type: "admitted" },
      { tMs: 200, type: "participant_count", count: 3 },
      { tMs: 300, type: "source_activity", sourceKey: "csrc:7", level: 0.5 },
    ]);
  });

  it("builds a timeline in time order without source_activity noise and with sweep changes only", () => {
    const raw = rawRun({
      samples: [sample(2, { rtc: talking(7), tiles: [tile(ZOFIA_ID)] })],
      platformEvents: [
        speaker(1500, ZOFIA, true),
        event(1600, { type: "source_activity", sourceKey: "csrc:7", level: 0.5 }),
      ],
      selectorSweeps: [
        sweep("activeSpeakerName", 0, 0, 1000),
        sweep("activeSpeakerName", 0, 0, 2000),
        sweep("activeSpeakerName", 1, 0, 3000),
      ],
      pageCalls: [call("isVisible", "chatButton", { tMs: 500 }), ...LEAVE_CALLS_OK],
    });
    const { timeline } = build(raw);

    expect(timeline.map((entry) => entry.tMs)).toEqual(
      [...timeline.map((entry) => entry.tMs)].sort((a, b) => a - b)
    );
    expect(timeline.filter((entry) => entry.kind === "sweep").map((entry) => entry.summary)).toEqual([
      "activeSpeakerName: matched 0, visible 0",
      "activeSpeakerName: matched 1, visible 0",
    ]);
    expect(timeline.filter((entry) => entry.kind === "event").map((entry) => entry.summary)).toEqual([
      "speaker Participant A speaking=true",
    ]);
    expect(timeline.find((entry) => entry.kind === "sample")?.summary).toBe(
      "sample 2: 1 tiles, 0 leave-like controls, 1 receivers, audio active, 0 dialogs"
    );
    expect(timeline.filter((entry) => entry.kind === "call").map((entry) => entry.summary)).toEqual([
      "isVisible leaveCallButton ok in 10 ms",
      "click leaveCallButton ok in 120 ms",
    ]);
    expect(timeline.filter((entry) => entry.kind === "leave").map((entry) => entry.summary)).toEqual([
      "pre-leave (50 ms)",
      "adapter.leave (200 ms)",
    ]);
  });
});

describe("buildProbeReport: tile keys", () => {
  const raw = rawRun({
    samples: [
      sample(1, { tiles: [tile(BOGDAN_ID)] }),
      // A video tile and a people-list entry of one participant carry the same id.
      sample(2, { tiles: [tile(ZOFIA_ID), tile(BOGDAN_ID), tile(ZOFIA_ID)] }),
    ],
    leave: leave({
      preLeave: { tMs: 60000, sweeps: [], sample: sample(60, { tiles: [tile(ZOFIA_ID)] }) },
      afterLeave: afterLeave({ samples: [sample(61, { tiles: [tile(LATE_ID), tile(BOGDAN_ID)] })] }),
    }),
  });

  it("numbers tiles in order of first sight and keeps the key across samples and the leave record", () => {
    const report = build(raw);

    expect(report.samples.map((entry) => entry.tiles.map((item) => item.tileKey))).toEqual([
      ["tile-1"],
      ["tile-2", "tile-1", "tile-2"],
    ]);
    expect(report.leave.preLeave.sample?.tiles.map((item) => item.tileKey)).toEqual(["tile-2"]);
    expect(report.leave.afterLeave?.samples[0]?.tiles.map((item) => item.tileKey)).toEqual([
      "tile-3",
      "tile-1",
    ]);
  });

  it.each([true, false])("never writes a raw participant id (redactNames %s)", (redactNames) => {
    const json = JSON.stringify(build(raw, redactNames));

    for (const id of RAW_IDS) expect(json).not.toContain(id);
    expect(json).not.toContain('participantId":"spaces');
  });
});

describe("buildProbeReport: redaction", () => {
  const namedSample = (sequence: number): RawPageSample =>
    sample(sequence, {
      leaveControls: [
        control({
          ariaLabel: `Leave call with ${ZOFIA}`,
          title: `${ZOFIA} title`,
          tooltip: `${BOGDAN} tooltip`,
          text: `Leave ${ZOFIA}`,
          ariaStates: { "aria-pressed": "false" },
          hitTest: "other",
          coveredBy: { tag: "div", role: "dialog", ariaLabel: `${BOGDAN} is presenting` },
        }),
      ],
      tiles: [
        tile(ZOFIA_ID, {
          strings: [
            located(ZOFIA, "text", true),
            located(`Mute ${ZOFIA}'s microphone`, "aria-label"),
            located(`${ZOFIA} (You)`, "tooltip"),
          ],
          ariaStates: { "aria-hidden": "true" },
        }),
        tile(BOGDAN_ID, { strings: [located(`Pin ${BOGDAN}`, "aria-label"), located(BOGDAN, "title")] }),
      ],
      dialogCount: 1,
      dialogs: [{ ariaLabel: `${ZOFIA} is presenting`, role: "dialog" }],
    });

  const raw = rawRun({
    samples: [namedSample(1)],
    platformEvents: [
      speaker(1500, ZOFIA, true),
      event(1600, { type: "source_identity", sourceKey: "csrc:7", participantId: ZOFIA_ID, name: ZOFIA }),
      event(1700, { type: "source_identity", sourceKey: "csrc:8", participantId: "device-77", name: BOGDAN }),
    ],
    leave: leave({
      preLeave: { tMs: 60000, sweeps: [], sample: namedSample(60) },
      adapterLog: [
        {
          tMs: 61000,
          level: "warn",
          message: LEAVE_WARNING,
          fields: {
            selectorKey: "leaveCallButton",
            errorName: "TimeoutError",
            state: "in_meeting",
            component: "GoogleMeetPageDriver",
            note: BOGDAN,
            attempt: 1,
            closed: false,
            detail: null,
          },
        },
      ],
      afterLeave: afterLeave({ samples: [namedSample(61)] }),
    }),
  });

  it("leaves no raw name in any string-bearing field when redacting", () => {
    const report = build(raw);
    const json = JSON.stringify(report);

    for (const secret of RAW_SECRETS) expect(json).not.toContain(secret);
    for (const id of [...RAW_IDS, "device-77"]) expect(json).not.toContain(id);
    expect(json).not.toContain(MEETING_CODE);

    const [first] = report.samples;
    expect(first?.leaveControls[0]).toMatchObject({
      ariaLabel: "Leave call with Participant A",
      title: "Participant A <x>",
      tooltip: "Participant B <x>",
      text: "Leave Participant A",
      ariaStates: { "aria-pressed": "false" },
      coveredBy: { tag: "div", role: "dialog", ariaLabel: "Participant B is presenting" },
    });
    expect(first?.tiles[0]?.strings.map((entry) => entry.value)).toEqual([
      "Participant A",
      "Mute Participant A's microphone",
      "Participant A (You)",
    ]);
    expect(first?.tiles[0]?.ariaStates).toEqual({ "aria-hidden": "true" });
    expect(first?.tiles[1]?.strings.map((entry) => entry.value)).toEqual([
      "Pin Participant B",
      "Participant B",
    ]);
    expect(first?.dialogs).toEqual([{ ariaLabel: "Participant A is presenting", role: "dialog" }]);
    expect(report.leave.preLeave.sample?.tiles[1]?.strings[1]?.value).toBe("Participant B");
    expect(report.leave.afterLeave?.samples[0]?.dialogs[0]?.ariaLabel).toBe("Participant A is presenting");
    expect(report.leave.adapterLog).toEqual([
      {
        tMs: 61000,
        level: "warn",
        message: LEAVE_WARNING,
        fields: {
          selectorKey: "leaveCallButton",
          errorName: "TimeoutError",
          state: "in_meeting",
          component: "<x>",
          note: "Participant B",
          attempt: 1,
          closed: false,
          detail: null,
        },
      },
    ]);
  });

  it("does not learn the self tile label as a name", () => {
    const report = build(
      rawRun({
        samples: [
          sample(1, {
            tiles: [
              tile(ZOFIA_ID, { strings: [located(" You ", "text", true)] }),
              tile(BOGDAN_ID, {
                strings: [located(BOGDAN, "text", true), located("You are muted", "tooltip")],
              }),
            ],
          }),
        ],
      })
    );

    expect(report.samples[0]?.tiles[0]?.strings[0]?.value).toBe(" You ");
    expect(report.samples[0]?.tiles[1]?.strings.map((entry) => entry.value)).toEqual([
      "Participant A",
      "You are muted",
    ]);
    expect(report.names.map((name) => name.alias)).toEqual(["Participant A"]);
  });

  it("writes class tokens, data-attribute names and aria state values as they are, capped in length", () => {
    const long = "x".repeat(MAX_MARKUP_STRING_LENGTH + 20);
    const capped = "x".repeat(MAX_MARKUP_STRING_LENGTH);
    const report = build(
      rawRun({
        samples: [
          sample(1, {
            leaveControls: [control({ dataAttributeNames: [long], ariaStates: { "aria-pressed": long } })],
            tiles: [
              tile(ZOFIA_ID, {
                classTokens: ["kssMZb", long],
                dataAttributeNames: ["data-ssrc", long],
                ariaStates: { "aria-expanded": "Custom State", "aria-label-ish": long },
                mutations: [{ attribute: "class", count: 1, toggledClassTokens: [long] }],
              }),
            ],
          }),
        ],
      })
    );
    const [first] = report.samples;

    expect(first?.leaveControls[0]).toMatchObject({
      dataAttributeNames: [capped],
      ariaStates: { "aria-pressed": capped },
    });
    expect(first?.tiles[0]).toMatchObject({
      classTokens: ["kssMZb", capped],
      dataAttributeNames: ["data-ssrc", capped],
      ariaStates: { "aria-expanded": "Custom State", "aria-label-ish": capped },
      mutations: [{ attribute: "class", count: 1, toggledClassTokens: [capped] }],
    });
  });

  it("rewrites speaker event names and ids and maps other participant ids to stable keys", () => {
    const report = build(raw);

    expect(report.platformEvents).toEqual([
      {
        tMs: 1500,
        type: "speaker",
        participantId: "name:Participant A",
        name: "Participant A",
        speaking: true,
      },
      {
        tMs: 1600,
        type: "source_identity",
        sourceKey: "csrc:7",
        participantId: "tile-1",
        name: "Participant A",
      },
      {
        tMs: 1700,
        type: "source_identity",
        sourceKey: "csrc:8",
        participantId: "participant-1",
        name: "Participant B",
      },
    ]);
  });

  it("records where each alias appeared without keeping the name", () => {
    expect(build(raw).names).toEqual([
      {
        alias: "Participant A",
        locations: ["text", "aria-label", "tooltip"],
        tileCount: 1,
        inSpeakerEvents: true,
      },
      { alias: "Participant B", locations: ["aria-label", "title"], tileCount: 1, inSpeakerEvents: true },
    ]);
  });

  it("keeps the strings raw without redaction, still without ids or the meeting code", () => {
    const report = build(raw, false);
    const json = JSON.stringify(report);

    for (const secret of RAW_SECRETS) expect(json).toContain(secret);
    for (const id of [...RAW_IDS, "device-77"]) expect(json).not.toContain(id);
    expect(json).not.toContain(MEETING_CODE);
    expect(report.samples[0]?.tiles[0]?.strings[1]?.value).toBe(`Mute ${ZOFIA}'s microphone`);
    expect(report.platformEvents[0]).toMatchObject({ participantId: `name:${ZOFIA}`, name: ZOFIA });
    expect(report.leave.adapterLog[0]?.fields.note).toBe(BOGDAN);
  });
});

describe("evaluateHypotheses: leave", () => {
  it("returns the thirteen verdicts in order, each with one sentence of evidence", () => {
    const verdicts = evaluateHypotheses(build(rawRun()));

    expect(verdicts.map((verdict) => verdict.id)).toEqual(ALL_IDS);
    for (const verdict of verdicts) {
      expect(verdict.evidence.endsWith(".")).toBe(true);
      expect(verdict.evidence).not.toMatch(/\.\s+[A-Z]/);
    }
  });

  it.each([
    "denied",
    "removed",
    "meeting_ended",
    "connection_lost",
    "admit_timeout",
    "join_failed",
  ] as const)("judges no leave hypothesis when the run ended as %s", (outcome) => {
    const base = rawRun({ pageCalls: LEAVE_CALLS_OK });
    const raw = { ...base, run: { ...base.run, outcome } };

    for (const id of ["L1", "L2", "L3", "L4", "L5", "L6"] as const) {
      const verdict = verdictOf(raw, id);
      expect(verdict.verdict).toBe("inconclusive");
      expect(verdict.evidence).toContain(`"${outcome}"`);
    }
  });

  it("L1 supported: control found, click returned, ended text shown", () => {
    const verdict = verdictOf(rawRun({ pageCalls: LEAVE_CALLS_OK }), "L1");

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain("120 ms");
    expect(verdict.evidence).toContain("400 ms");
  });

  it("L1 inconclusive otherwise, and says it cannot be excluded by the probe", () => {
    const failed = verdictOf(
      rawRun({
        pageCalls: [
          call("click", "leaveCallButton", { errorName: "TimeoutError", result: null, durationMs: 3100 }),
        ],
        leave: leave({ afterLeave: afterLeave({ endedTextVisible: false, msFromClickToEndedText: null }) }),
      }),
      "L1"
    );
    const noClick = verdictOf(rawRun({ leave: leave({ afterLeave: null }) }), "L1");

    expect(failed.verdict).toBe("inconclusive");
    expect(failed.evidence).toContain("TimeoutError after 3100 ms");
    expect(failed.evidence).toContain("ended text visible=false");
    expect(failed.evidence).toContain("never sends");
    expect(noClick.verdict).toBe("inconclusive");
    expect(noClick.evidence).toContain("no leave click was recorded");
  });

  it("L2 supported when the adapter saw no visible control", () => {
    const verdict = verdictOf(
      rawRun({
        pageCalls: [call("isVisible", "leaveCallButton", { result: { kind: "boolean", value: false } })],
        leave: leave({
          preLeave: {
            tMs: 60000,
            sweeps: [sweep("leaveCallButton", 0, 0, 60000)],
            sample: sample(60, { leaveControls: [control(), control()] }),
          },
        }),
      }),
      "L2"
    );

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain("returned false");
    expect(verdict.evidence).toContain("matched 0 and saw 0 visible");
    expect(verdict.evidence).toContain("2 leave-like controls");
  });

  it("L2 excluded when the adapter saw the control", () => {
    const verdict = verdictOf(rawRun({ pageCalls: LEAVE_CALLS_OK }), "L2");

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("returned true");
    expect(verdict.evidence).toContain("matched 1 and saw 1 visible");
  });

  it("L2 falls back to the pre-leave sweep when the adapter call is missing", () => {
    const preLeave = (visible: number, controls: RawElementFacts[] | null) =>
      rawRun({
        leave: leave({
          preLeave: {
            tMs: 60000,
            sweeps: [sweep("leaveCallButton", visible, visible, 60000)],
            sample: controls ? sample(60, { leaveControls: controls }) : null,
          },
        }),
      });

    expect(verdictOf(preLeave(1, null), "L2").verdict).toBe("excluded");
    expect(verdictOf(preLeave(0, [control()]), "L2").verdict).toBe("supported");
    expect(verdictOf(preLeave(0, []), "L2")).toMatchObject({ verdict: "inconclusive" });
    expect(verdictOf(preLeave(0, []), "L2").evidence).toContain("0 leave-like controls");
    expect(verdictOf(preLeave(0, null), "L2").evidence).toContain("no pre-leave page sample");
  });

  it("L2 inconclusive when the pre-leave selector read failed and no adapter call exists", () => {
    const verdict = verdictOf(
      rawRun({
        leave: leave({ preLeave: { tMs: 60000, sweeps: [sweep("leaveCallButton", -1, -1)], sample: null } }),
      }),
      "L2"
    );

    expect(verdict.verdict).toBe("inconclusive");
    expect(verdict.evidence).toContain("selector read of leaveCallButton failed");
    expect(verdict.evidence).not.toContain("-1");
  });

  it("L2 inconclusive without any pre-leave sweep or adapter call", () => {
    const verdict = verdictOf(
      rawRun({ leave: leave({ preLeave: { tMs: 60000, sweeps: [], sample: null } }) }),
      "L2"
    );

    expect(verdict.verdict).toBe("inconclusive");
    expect(verdict.evidence).toContain("no pre-leave sweep of leaveCallButton");
  });

  const withClick = (click: Partial<RecordedPageCall>, controls: RawElementFacts[] | null) =>
    rawRun({
      pageCalls: [call("isVisible", "leaveCallButton"), call("click", "leaveCallButton", click)],
      leave: leave({
        preLeave: {
          tMs: 60000,
          sweeps: [sweep("leaveCallButton", 1, 1, 60000)],
          sample: controls ? sample(60, { leaveControls: controls }) : null,
        },
      }),
    });
  const covered = control({ hitTest: "other", coveredBy: { tag: "div", role: null, ariaLabel: null } });

  it("L3 excluded when the click returned", () => {
    const verdict = verdictOf(withClick({ durationMs: 120 }, [control()]), "L3");

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("120 ms");
    expect(verdict.evidence).toContain("0 of 1 leave-like controls");
  });

  it("L3 supported when the click timed out or a control was covered", () => {
    const timedOut = verdictOf(
      withClick({ errorName: "TimeoutError", result: null, durationMs: 2900 }, [control()]),
      "L3"
    );
    const closed = verdictOf(
      withClick({ errorName: "TargetClosedError", result: null, durationMs: 3010 }, [covered, control()]),
      "L3"
    );

    expect(timedOut.verdict).toBe("supported");
    expect(timedOut.evidence).toContain("TimeoutError after 2900 ms");
    expect(closed.verdict).toBe("supported");
    expect(closed.evidence).toContain("1 of 2 leave-like controls");
  });

  it("L3 inconclusive when the click failed for another reason or was never attempted", () => {
    const closed = verdictOf(
      withClick({ errorName: "TargetClosedError", result: null, durationMs: 3010 }, [control()]),
      "L3"
    );
    const noClick = verdictOf(rawRun(), "L3");

    expect(closed.verdict).toBe("inconclusive");
    expect(closed.evidence).toContain("TargetClosedError after 3010 ms");
    expect(noClick.verdict).toBe("inconclusive");
    expect(noClick.evidence).toContain("No leave click was attempted");
  });

  it("L4 compares the click duration with the 3000 ms driver cap", () => {
    const slow = verdictOf(withClick({ durationMs: 3200 }, null), "L4");
    const fast = verdictOf(withClick({ durationMs: 120 }, null), "L4");
    const none = verdictOf(rawRun(), "L4");

    expect(slow.verdict).toBe("supported");
    expect(slow.evidence).toContain("3200 ms");
    expect(slow.evidence).toContain("cap of 3000 ms");
    expect(fast.verdict).toBe("excluded");
    expect(fast.evidence).toContain("120 ms");
    expect(none.verdict).toBe("inconclusive");
    expect(none.evidence).toContain("No leave click was recorded");
  });

  it("L5 supported when a dialog stays and no ended text shows", () => {
    const byKey = verdictOf(
      rawRun({
        pageCalls: LEAVE_CALLS_OK,
        leave: leave({
          afterLeave: afterLeave({
            endedTextVisible: false,
            msFromClickToEndedText: null,
            dialogKeysVisible: ["dialogGotIt"],
          }),
        }),
      }),
      "L5"
    );
    const bySample = verdictOf(
      rawRun({
        pageCalls: LEAVE_CALLS_OK,
        leave: leave({
          afterLeave: afterLeave({
            endedTextVisible: false,
            msFromClickToEndedText: null,
            samples: [sample(61, { dialogCount: 2 })],
          }),
        }),
      }),
      "L5"
    );

    expect(byKey.verdict).toBe("supported");
    expect(byKey.evidence).toContain("1 dialogs were present and ended text visible=false within 3000 ms");
    expect(bySample.verdict).toBe("supported");
    expect(bySample.evidence).toContain("2 dialogs");
  });

  it("L5 excluded when the ended text shows or no dialog appears", () => {
    const verdict = verdictOf(rawRun({ pageCalls: LEAVE_CALLS_OK }), "L5");

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("0 dialogs were present and ended text visible=true");
  });

  it("L5 and L6 inconclusive without an after-leave observation or a landed click", () => {
    const noAfter = rawRun({ pageCalls: LEAVE_CALLS_OK, leave: leave({ afterLeave: null }) });
    const noClick = rawRun();

    for (const id of ["L5", "L6"] as const) {
      expect(verdictOf(noAfter, id).verdict).toBe("inconclusive");
      expect(verdictOf(noAfter, id).evidence).toContain("No after-leave observation");
      expect(verdictOf(noClick, id).verdict).toBe("inconclusive");
      expect(verdictOf(noClick, id).evidence).toContain("did not land");
    }
  });

  it("L6 compares the delay of the ended text with the threshold", () => {
    const at = (msFromClickToEndedText: number | null, endedTextVisible = true) =>
      verdictOf(
        rawRun({
          pageCalls: LEAVE_CALLS_OK,
          leave: leave({ afterLeave: afterLeave({ msFromClickToEndedText, endedTextVisible }) }),
        }),
        "L6"
      );

    expect(at(900).verdict).toBe("supported");
    expect(at(900).evidence).toContain("900 ms");
    expect(at(900).evidence).toContain(`${LEAVE_REGISTER_FAST_MS} ms`);
    expect(at(100).verdict).toBe("excluded");
    expect(at(100).evidence).toContain("100 ms");
    expect(at(null, false).verdict).toBe("inconclusive");
    expect(at(null, false).evidence).toContain("did not appear within 3000 ms");
    expect(at(null, true).evidence).toContain("not measured");
  });
});

describe("evaluateHypotheses: speakers", () => {
  const speech = (checks: RawSelectorCheck[], count = 4) =>
    samples(count, () => ({ rtc: talking(7), selectorChecks: checks, tiles: [tile(ZOFIA_ID)] }));

  it.each(["S1", "S2"] as const)("%s inconclusive without samples or without verifiable speech", (id) => {
    const none = verdictOf(rawRun(), id);
    const silent = verdictOf(
      rawRun({
        samples: [
          ...samples(5, () => ({ rtc: rtc([source(7, AUDIO_ACTIVE_LEVEL)]) })),
          ...samples(MIN_AUDIO_ACTIVE_SAMPLES - 1, () => ({ rtc: talking(7) }), 6),
        ],
      }),
      id
    );

    expect(none.verdict).toBe("inconclusive");
    expect(none.evidence).toContain("no page samples");
    expect(silent.verdict).toBe("inconclusive");
    expect(silent.evidence).toContain("only 2 of 7 samples");
    expect(silent.evidence).toContain("above 0.05");
  });

  it("S1 supported: no tile holds a speaking label while audio is active", () => {
    const verdict = verdictOf(
      rawRun({
        samples: speech([check(TILE_SPEAKING, 0), check(ANY_SPEAKING, 2)]),
        selectorSweeps: [sweep("activeSpeakerName", 0, 0), sweep("activeSpeakerName", 0, 0, 2000)],
      }),
      "S1"
    );

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain("0 of 4 checked samples with audio");
    expect(verdict.evidence).toContain("at most 0 in 2 sweeps (0 more reads failed)");
    expect(verdict.evidence).toContain("matched at most 2 anywhere");
  });

  it("S1 inconclusive when every activeSpeakerName read failed, without reading -1 as a count", () => {
    const verdict = verdictOf(
      rawRun({
        samples: speech([check(TILE_SPEAKING, 0)]),
        selectorSweeps: [sweep("activeSpeakerName", -1, -1), sweep("activeSpeakerName", 0, -1, 2000)],
      }),
      "S1"
    );

    expect(verdict.verdict).toBe("inconclusive");
    expect(verdict.evidence).toContain("selector read failed in all 2 activeSpeakerName sweeps");
    expect(verdict.evidence).not.toContain("-1");
  });

  it("S1 inconclusive when the page could not evaluate the label selector in some samples with audio", () => {
    const verdict = verdictOf(
      rawRun({
        samples: [...speech([check(TILE_SPEAKING, 0)], 3), ...samples(2, () => ({ rtc: talking(7) }), 4)],
      }),
      "S1"
    );

    expect(verdict.verdict).toBe("inconclusive");
    expect(verdict.evidence).toContain(`could not evaluate ${TILE_SPEAKING} in 2 of 5 samples with audio`);
  });

  it("S1 excluded: a tile holds a speaking label while audio is active", () => {
    const verdict = verdictOf(rawRun({ samples: speech([check(TILE_SPEAKING, 1)]) }), "S1");

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("4 of 4 checked samples with audio");
  });

  it("S1 tolerates a collector that spells the selector with other quotes", () => {
    const verdict = verdictOf(
      rawRun({ samples: speech([check("[data-participant-id]:has([aria-label*='speaking' i])", 1)]) }),
      "S1"
    );

    expect(verdict.verdict).toBe("excluded");
  });

  it.each(["S1", "S2"] as const)("%s inconclusive when the in-page label check is missing", (id) => {
    const verdict = verdictOf(rawRun({ samples: speech([]) }), id);

    expect(verdict.verdict).toBe("inconclusive");
    expect(verdict.evidence).toContain(TILE_SPEAKING);
  });

  const toggling = (count: number, sequence: number) =>
    sample(sequence, {
      rtc: talking(7),
      selectorChecks: [check(TILE_SPEAKING, 0)],
      tiles: [
        tile(ZOFIA_ID, {
          mutations: count > 0 ? [{ attribute: "class", count, toggledClassTokens: ["kssMZb"] }] : [],
        }),
      ],
    });
  const still = (count: number, sequence: number) =>
    sample(sequence, {
      selectorChecks: [check(TILE_SPEAKING, 0)],
      tiles: [
        tile(ZOFIA_ID, {
          mutations: count > 0 ? [{ attribute: "style", count, toggledClassTokens: [] }] : [],
        }),
      ],
    });
  const mutationRun = (activeCount: number, quietCount: number, quietSamples = 4) =>
    rawRun({
      samples: [
        ...[1, 2, 3, 4].map((sequence) => toggling(activeCount, sequence)),
        ...Array.from({ length: quietSamples }, (_, index) => still(quietCount, 5 + index)),
      ],
    });

  it("S2 supported: class or style changes follow the audio and no label exists", () => {
    const verdict = verdictOf(mutationRun(2, 0), "S2");

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain("8 times in 4 samples with audio (2.00 per sample)");
    expect(verdict.evidence).toContain("0 times in 4 quiet samples (0.00 per sample)");
    expect(verdict.evidence).toContain("kssMZb");
  });

  it("S2 excluded: a label shows speaking, or nothing changes at all", () => {
    const labelled = verdictOf(rawRun({ samples: speech([check(TILE_SPEAKING, 1)]) }), "S2");
    const frozen = verdictOf(mutationRun(0, 0), "S2");

    expect(labelled.verdict).toBe("excluded");
    expect(labelled.evidence).toContain("4 of 4 checked samples with audio");
    expect(frozen.verdict).toBe("excluded");
    expect(frozen.evidence).toContain("0 times in 4 samples with audio");
  });

  it("S2 inconclusive: changes do not follow the audio, or too few quiet samples", () => {
    const same = verdictOf(mutationRun(2, 2), "S2");
    const fewQuiet = verdictOf(mutationRun(2, 0, 1), "S2");
    const noTiles = verdictOf(
      rawRun({ samples: samples(4, () => ({ rtc: talking(7), selectorChecks: [check(TILE_SPEAKING, 0)] })) }),
      "S2"
    );

    expect(same.verdict).toBe("inconclusive");
    expect(same.evidence).toContain("(2.00 per sample) against 8 times in 4 quiet samples (2.00 per sample)");
    expect(fewQuiet.verdict).toBe("inconclusive");
    expect(fewQuiet.evidence).toContain("in 1 quiet samples");
    expect(noTiles.verdict).toBe("inconclusive");
    expect(noTiles.evidence).toContain("none of the 4 samples with audio held a participant tile");
  });

  it("S3 supported: names sit only in labels, never in a span.notranslate", () => {
    const verdict = verdictOf(
      rawRun({
        samples: samples(2, () => ({
          selectorChecks: [check(TILE_NAME_SPAN, 0)],
          tiles: [tile(ZOFIA_ID, { strings: [located(`Pin ${ZOFIA}`, "aria-label")] })],
        })),
      }),
      "S3"
    );

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain("matched at most 0 in 2 checked samples");
    expect(verdict.evidence).toContain("0 of 2 tile strings");
    expect(verdict.evidence).toContain("1 of 1 aliased names appeared only in a label");
    expect(verdict.evidence).not.toContain("Zofia");
  });

  it("S3 excluded: a tile holds a span.notranslate", () => {
    const verdict = verdictOf(
      rawRun({
        samples: [
          sample(1, {
            selectorChecks: [check(TILE_NAME_SPAN, 2)],
            tiles: [tile(ZOFIA_ID, { strings: [located(ZOFIA, "text", true)] })],
          }),
        ],
      }),
      "S3"
    );

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("matched at most 2 in 1 checked samples");
    expect(verdict.evidence).toContain("1 of 1 tile strings");
  });

  it("S3 inconclusive without tiles or without anything read from them", () => {
    const noTiles = verdictOf(rawRun({ samples: samples(3, () => ({})) }), "S3");
    const bare = verdictOf(rawRun({ samples: samples(3, () => ({ tiles: [tile(ZOFIA_ID)] })) }), "S3");

    expect(noTiles.verdict).toBe("inconclusive");
    expect(noTiles.evidence).toContain("none of the 3 page samples held a participant tile");
    expect(bare.verdict).toBe("inconclusive");
    expect(bare.evidence).toContain(`could not evaluate ${TILE_NAME_SPAN} in 3 of 3 samples with tiles`);
  });

  it("S3 still excluded by a span.notranslate string when the page check is missing", () => {
    const verdict = verdictOf(
      rawRun({
        samples: [sample(1, { tiles: [tile(ZOFIA_ID, { strings: [located(ZOFIA, "text", true)] })] })],
      }),
      "S3"
    );

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("1 of 1 tile strings");
  });

  it("S4 supported: the name label matches but is never visible", () => {
    const verdict = verdictOf(
      rawRun({
        samples: samples(2, () => ({ selectorChecks: [check(TILE_NAME_SPAN, 3, 0)] })),
        selectorSweeps: [sweep("activeSpeakerName", 1, 0)],
      }),
      "S4"
    );

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain(
      "Of 3 name-label readings that matched (2 in-page, 1 activeSpeakerName sweeps, 0 more sweep reads failed)"
    );
    expect(verdict.evidence).toContain("3 had 0 visible and 0 had a visible match");
  });

  it("S4 excluded: a matching name label is visible", () => {
    const verdict = verdictOf(
      rawRun({
        samples: [
          sample(1, { selectorChecks: [check(TILE_NAME_SPAN, 3, 0)] }),
          sample(2, { selectorChecks: [check(TILE_NAME_SPAN, 3, 2)] }),
        ],
      }),
      "S4"
    );

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("1 had 0 visible and 1 had a visible match");
  });

  it("S4 inconclusive when no name label ever matched", () => {
    const never = verdictOf(
      rawRun({
        samples: samples(2, () => ({ selectorChecks: [check(TILE_NAME_SPAN, 0)] })),
        selectorSweeps: [sweep("activeSpeakerName", 0, 0), sweep("activeSpeakerName", -1, -1)],
      }),
      "S4"
    );

    expect(never.verdict).toBe("inconclusive");
    expect(never.evidence).toContain("2 samples, 1 activeSpeakerName sweeps");
    expect(verdictOf(rawRun(), "S4").evidence).toContain("no page samples and no activeSpeakerName sweeps");
  });

  it("S4 inconclusive when the selector read failed or the page could not evaluate the name selector", () => {
    const failed = verdictOf(
      rawRun({
        samples: samples(2, () => ({ selectorChecks: [check(TILE_NAME_SPAN, 0)] })),
        selectorSweeps: [sweep("activeSpeakerName", -1, -1)],
      }),
      "S4"
    );
    const missing = verdictOf(
      rawRun({ samples: [sample(1, { selectorChecks: [check(TILE_NAME_SPAN, 3, 0)] }), sample(2)] }),
      "S4"
    );
    const allMissing = verdictOf(rawRun({ samples: samples(2, () => ({})) }), "S4");

    expect(failed.verdict).toBe("inconclusive");
    expect(failed.evidence).toContain("selector read failed in all 1 activeSpeakerName sweeps");
    expect(missing.verdict).toBe("inconclusive");
    expect(missing.evidence).toContain(`could not evaluate ${TILE_NAME_SPAN} in 1 of 2 samples`);
    expect(missing.evidence).toContain("1 had 0 visible");
    expect(allMissing.verdict).toBe("inconclusive");
    expect(allMissing.evidence).toContain(`could not evaluate ${TILE_NAME_SPAN} in 2 of 2 samples`);
  });

  const flicker = (name: string, from: number): RawPlatformEvent[] => [
    speaker(from, name, true),
    speaker(from + 200, name, false),
    speaker(from + 1000, name, true),
    speaker(from + 1200, name, false),
    speaker(from + 2000, name, true),
    speaker(from + 2200, name, false),
  ];
  const steady = (name: string, from: number): RawPlatformEvent[] => [
    speaker(from, name, true),
    speaker(from + 4000, name, false),
  ];

  it("S5 supported: the indicator covers too little of the turns", () => {
    const verdict = verdictOf(rawRun({ platformEvents: flicker(ZOFIA, 1000) }), "S5");

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain("1 of 1 turns (from 6 speaker events)");
    expect(verdict.evidence).toContain("less than 0.6");
    expect(verdict.evidence).toContain("lowest 0.27");
    expect(verdict.evidence).not.toContain("Zofia");
  });

  it("S5 excluded: every turn is covered", () => {
    const verdict = verdictOf(rawRun({ platformEvents: steady(ZOFIA, 1000) }), "S5");

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("0 of 1 turns (from 2 speaker events)");
    expect(verdict.evidence).toContain("lowest 1.00");
  });

  it("S5 closes a turn left open at the last platform event", () => {
    const verdict = verdictOf(
      rawRun({ platformEvents: [speaker(1000, ZOFIA, true), event(6000, { type: "meeting_ended" })] }),
      "S5"
    );

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("0 of 1 turns (from 1 speaker events)");
  });

  it("S5 inconclusive: no speaker events, no turn long enough, or a minority of short turns", () => {
    const none = verdictOf(rawRun(), "S5");
    const blip = verdictOf(
      rawRun({ platformEvents: [speaker(1000, ZOFIA, true), speaker(1300, ZOFIA, false)] }),
      "S5"
    );
    const minority = verdictOf(
      rawRun({
        platformEvents: [...steady(ZOFIA, 1000), ...steady(BOGDAN, 6000), ...flicker("Celina Sowa", 12000)],
      }),
      "S5"
    );

    expect(none.verdict).toBe("inconclusive");
    expect(none.evidence).toContain("0 speaker events");
    expect(blip.verdict).toBe("inconclusive");
    expect(blip.evidence).toContain("2 speaker events arrived but no turn lasted 1000 ms");
    expect(minority.verdict).toBe("inconclusive");
    expect(minority.evidence).toContain("1 of 3 turns (from 10 speaker events)");
  });

  it("S6 supported: the selector had visible names and no speaker event arrived", () => {
    const verdict = verdictOf(
      rawRun({ selectorSweeps: [sweep("activeSpeakerName", 1, 1), sweep("activeSpeakerName", 0, 0, 2000)] }),
      "S6"
    );

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain(
      "visible match in 1 of 2 sweeps (0 more reads failed) and 0 speaker events"
    );
  });

  it("S6 excluded: visible names and speaker events", () => {
    const verdict = verdictOf(
      rawRun({ selectorSweeps: [sweep("activeSpeakerName", 1, 1)], platformEvents: steady(ZOFIA, 1000) }),
      "S6"
    );

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain(
      "visible match in 1 of 1 sweeps (0 more reads failed) and 2 speaker events"
    );
  });

  it("S6 inconclusive: no sweep, or nothing visible to read", () => {
    const none = verdictOf(rawRun({ selectorSweeps: [sweep("activeSpeakerName", -1, -1)] }), "S6");
    const hidden = verdictOf(rawRun({ selectorSweeps: [sweep("activeSpeakerName", 1, 0)] }), "S6");

    expect(none.verdict).toBe("inconclusive");
    expect(none.evidence).toContain("selector read failed in all 1 activeSpeakerName sweeps");
    expect(verdictOf(rawRun(), "S6").evidence).toContain("no activeSpeakerName sweep was recorded");
    expect(hidden.verdict).toBe("inconclusive");
    expect(hidden.evidence).toContain("visible match in 0 of 1 sweeps");
  });

  const heard = { frames: 100, nonSilentFrames: 60 };
  const count = (value: number): RawPlatformEvent => event(100, { type: "participant_count", count: value });

  it("S7 supported: audio is heard but no source entry carries a level", () => {
    const verdict = verdictOf(
      rawRun({ audio: heard, samples: samples(3, () => ({ rtc: rtc([source(7, null)]) })) }),
      "S7"
    );

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain("3 source entries of which 0 carried a level");
    expect(verdict.evidence).toContain("60 of 100 captured audio frames");
  });

  it("S7 supported: the source timestamps are on another scale", () => {
    const verdict = verdictOf(
      rawRun({
        audio: heard,
        samples: samples(4, (sequence) => ({
          rtc: rtc([source(7, 0.4, sequence % 2 === 0 ? null : 1.7e12)]),
        })),
      }),
      "S7"
    );

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain("4 of those had an age outside 10000 ms");
  });

  it("S7 supported: levels exist but never rise with the audio", () => {
    const verdict = verdictOf(
      rawRun({ audio: heard, samples: samples(3, () => ({ rtc: rtc([source(7, 0)]) })) }),
      "S7"
    );

    expect(verdict.verdict).toBe("supported");
    expect(verdict.evidence).toContain("0 distinct sources rose above 0.05");
  });

  it("S7 excluded: two sources carry levels with usable ages among three others", () => {
    const verdict = verdictOf(
      rawRun({
        audio: heard,
        platformEvents: [count(4)],
        samples: samples(4, (sequence) => ({ rtc: rtc([source(sequence % 2 === 0 ? 7 : 8, 0.4)], 3) })),
      }),
      "S7"
    );

    expect(verdict.verdict).toBe("excluded");
    expect(verdict.evidence).toContain("at most 3 audio receivers for 3 other participants");
    expect(verdict.evidence).toContain("2 distinct sources rose above 0.05");
    expect(verdict.evidence).toContain("0 of those had an age outside 10000 ms");
  });

  it("S7 inconclusive: no samples, nobody spoke, fewer than two others, or one active source", () => {
    const none = verdictOf(rawRun({ audio: heard }), "S7");
    const silent = verdictOf(rawRun({ samples: samples(3, () => ({ rtc: rtc([source(7, 0)]) })) }), "S7");
    const alone = verdictOf(
      rawRun({ audio: heard, platformEvents: [count(2)], samples: samples(3, () => ({ rtc: talking(7) })) }),
      "S7"
    );
    const byTiles = verdictOf(
      rawRun({
        audio: heard,
        samples: samples(3, () => ({
          rtc: talking(7),
          tiles: [tile(ZOFIA_ID), tile(BOGDAN_ID), tile(ZOFIA_ID)],
        })),
      }),
      "S7"
    );
    const oneSource = verdictOf(
      rawRun({ audio: heard, platformEvents: [count(4)], samples: samples(3, () => ({ rtc: talking(7) })) }),
      "S7"
    );

    expect(none).toMatchObject({
      verdict: "inconclusive",
      evidence: "Not judged: no page samples were collected.",
    });
    expect(silent.verdict).toBe("inconclusive");
    expect(silent.evidence).toContain("nobody verifiably spoke");
    expect(silent.evidence).toContain("0 of 0 captured audio frames");
    expect(alone.verdict).toBe("inconclusive");
    expect(alone.evidence).toContain("Fewer than two other participants");
    expect(alone.evidence).toContain("for 1 other participants");
    expect(byTiles.verdict).toBe("inconclusive");
    expect(byTiles.evidence).toContain("for 1 other participants");
    expect(oneSource.verdict).toBe("inconclusive");
    expect(oneSource.evidence).toContain("Only one source was ever active");
    expect(oneSource.evidence).toContain("1 distinct sources rose above 0.05");
  });
});

describe("formatSummary", () => {
  const verdicts: HypothesisVerdict[] = ALL_IDS.map((id, index) => ({
    id,
    verdict: (["supported", "excluded", "inconclusive"] as const)[index % 3] ?? "inconclusive",
    evidence: `Evidence for ${id}.`,
  }));

  it("groups one line per hypothesis under Leave and Speakers, then the file and the reminder", () => {
    const lines = formatSummary(verdicts, "/home/owner/meet-probe.json").split("\n");

    expect(lines[0]).toBe("Meet probe summary");
    expect(lines.indexOf("Leave")).toBe(2);
    expect(lines.indexOf("Speakers")).toBe(10);
    expect(lines.slice(3, 9).map((line) => line.trim().slice(0, 2))).toEqual([
      "L1",
      "L2",
      "L3",
      "L4",
      "L5",
      "L6",
    ]);
    expect(lines.slice(11, 18).map((line) => line.trim().slice(0, 2))).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
      "S5",
      "S6",
      "S7",
    ]);
    expect(lines[3]).toBe("  L1  supported     browser closed by the stop signal: Evidence for L1.");
    expect(lines[4]).toBe("  L2  excluded      leave selector matches nothing visible: Evidence for L2.");
    expect(lines[5]).toContain("  L3  inconclusive  ");
    expect(lines[19]).toBe("File to send back: /home/owner/meet-probe.json");
    expect(lines[20]).toContain("search the file for participant names");
    expect(lines[21]).toBe("");
  });

  it("lists all thirteen ids even when a verdict is missing", () => {
    const summary = formatSummary(verdicts.slice(0, 2), "/home/owner/meet-probe.json");

    for (const id of ALL_IDS) expect(summary).toMatch(new RegExp(`^  ${id}  `, "m"));
    expect(summary).toMatch(/^ {2}S7 {2}not evaluated/m);
  });

  it("holds no name and no URL for a real report", () => {
    const report = build(
      rawRun({ platformEvents: [speaker(1000, ZOFIA, true), speaker(5000, ZOFIA, false)] })
    );
    const summary = formatSummary(report.hypotheses, "/home/owner/meet-probe.json");

    for (const secret of RAW_SECRETS) expect(summary).not.toContain(secret);
    expect(summary).not.toContain("meet.google.com");
    expect(summary).not.toContain(MEETING_CODE);
  });
});
