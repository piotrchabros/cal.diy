// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { PlatformEvent } from "../src/platform/PlatformAdapter";
import { IN_CALL_SELECTOR_KEYS } from "./meetProbeRecorder";
import { findLeaks } from "./meetProbeRedaction";
import {
  afterLeaveStep,
  buildSecrets,
  collectRawNames,
  meetingCodeOf,
  PROBE_DISPLAY_NAME,
  type ProbeSecretSources,
  resolveOutcome,
  sweepKeysForTick,
  terminalOutcomeOf,
  toLogLine,
} from "./meetProbeRun";
import type {
  RawAfterLeaveObservation,
  RawLocatedString,
  RawPageSample,
  RawPlatformEvent,
  RecordedPageCall,
} from "./meetProbeTypes";

const MEETING_URL = "https://meet.google.com/abc-defg-hij";

const located = (value: string, isNotranslateSpan: boolean): RawLocatedString => ({
  value,
  where: "text",
  visible: true,
  isNotranslateSpan,
});

const sample = (strings: RawLocatedString[][]): RawPageSample => ({
  sequence: 1,
  pageTimeMs: 0,
  leaveControls: [],
  tiles: strings.map((tileStrings, index) => ({
    participantId: `raw-${index}`,
    classTokens: [],
    strings: tileStrings,
    dataAttributeNames: [],
    ariaStates: {},
    mutations: [],
    mutationCount: 0,
  })),
  selectorChecks: [],
  rtc: { peerConnectionCount: 0, receivers: [] },
  visibilityState: "visible",
  hasFocus: true,
  dialogCount: 0,
  dialogs: [],
});

const events = (...list: PlatformEvent[]): RawPlatformEvent[] =>
  list.map((event, index) => ({ tMs: index, event }));

const speaker = (name: string): PlatformEvent => ({
  type: "speaker",
  participantId: `name:${name}`,
  name,
  speaking: true,
});

const sources = (overrides: Partial<ProbeSecretSources> = {}): ProbeSecretSources => ({
  meetingUrl: MEETING_URL,
  accountEmail: null,
  accountPassword: null,
  storageStateValue: undefined,
  redactNames: true,
  rawNames: [],
  ...overrides,
});

// The fixed parts of a written report that a participant name can collide with.
const reportJson = (strings: string[] = []): string =>
  `${JSON.stringify(
    {
      schemaVersion: 1,
      tool: "meet-probe",
      run: {
        outcome: "completed",
        chrome: { channel: "chrome", headless: false },
        meeting: { host: "meet.google.com" },
      },
      selectors: { leaveCallButton: '[aria-label*="Leave call" i]:visible' },
      names: [{ alias: "Participant A", locations: ["text"], tileCount: 1, inSpeakerEvents: true }],
      strings,
    },
    null,
    2
  )}\n`;

const nameLeaks = (json: string, names: string[]): string[] =>
  findLeaks(json, buildSecrets(sources({ rawNames: collectRawNames(events(...names.map(speaker)), []) })));

describe("toLogLine", () => {
  it("splits a logger line into level, message and scalar fields, with the probe's own time", () => {
    const line = JSON.stringify({
      time: "2026-01-01T00:00:00.000Z",
      level: "warn",
      message: "leave control not visible",
      component: "meet-probe",
      selectorKey: "leaveCallButton",
      attempt: 2,
      visible: false,
      detail: null,
    });

    expect(toLogLine(line, 1234)).toEqual({
      tMs: 1234,
      level: "warn",
      message: "leave control not visible",
      fields: {
        component: "meet-probe",
        selectorKey: "leaveCallButton",
        attempt: 2,
        visible: false,
        detail: null,
      },
    });
  });

  it("drops nested values and never keeps the logger's own time", () => {
    const entry = toLogLine(
      JSON.stringify({ time: "t", level: "info", message: "m", nested: { a: 1 }, list: [1, 2] }),
      5
    );

    expect(entry).toEqual({ tMs: 5, level: "info", message: "m", fields: {} });
  });

  it("falls back to an unknown level and an empty message", () => {
    expect(toLogLine("{}", 7)).toEqual({ tMs: 7, level: "unknown", message: "", fields: {} });
  });

  it("keeps a level or message of the wrong type as a field only when it is a scalar", () => {
    expect(toLogLine(JSON.stringify({ level: 30, message: { text: "x" } }), 0)).toEqual({
      tMs: 0,
      level: "unknown",
      message: "",
      fields: { level: 30 },
    });
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["an empty line", ""],
    ["a JSON string", '"text"'],
    ["a JSON number", "42"],
    ["null", "null"],
  ])("returns null for %s", (_name, line) => {
    expect(toLogLine(line, 0)).toBeNull();
  });
});

describe("collectRawNames", () => {
  it("collects whole names from speaker events, source identities and name spans", () => {
    const names = collectRawNames(
      events(
        { type: "admitted" },
        speaker("Ada Lovelace"),
        { type: "source_identity", sourceKey: "ssrc-1", participantId: "p1", name: "Grzegorz" },
        { type: "source_activity", sourceKey: "ssrc-1", level: 0.4 }
      ),
      [sample([[located("Zofia Wójcik", true), located("Zofia Wójcik is speaking", false)]])]
    );

    expect(names).toEqual(["Ada Lovelace", "Grzegorz", "Zofia Wójcik"]);
  });

  it("never splits a name into its words", () => {
    const names = collectRawNames(events(speaker("Google Something Longer")), [
      sample([[located("Chrome Canary", true)]]),
    ]);

    expect(names).toEqual(["Google Something Longer", "Chrome Canary"]);
  });

  it("trims and deduplicates", () => {
    const names = collectRawNames(events(speaker("  Ada Lovelace "), speaker("Ada Lovelace")), [
      sample([[located("Ada Lovelace", true)], [located("\tAda Lovelace\n", true)]]),
    ]);

    expect(names).toEqual(["Ada Lovelace"]);
  });

  it("skips the bot's own tile label, the probe's display name and empty strings", () => {
    const names = collectRawNames(
      events(speaker("You"), speaker(PROBE_DISPLAY_NAME), speaker(PROBE_DISPLAY_NAME.toUpperCase())),
      [sample([[located("you", true), located("   ", true), located("", true)]])]
    );

    expect(names).toEqual([]);
  });

  it("ignores tile strings that are not name spans", () => {
    expect(collectRawNames([], [sample([[located("Pin Ada Lovelace to your main screen", false)]])])).toEqual(
      []
    );
  });
});

describe("meetingCodeOf", () => {
  it("takes the last path segment of the meeting URL", () => {
    expect(meetingCodeOf(MEETING_URL)).toBe("abc-defg-hij");
    expect(meetingCodeOf(`${MEETING_URL}/`)).toBe("abc-defg-hij");
    expect(meetingCodeOf(`${MEETING_URL}?authuser=1#x`)).toBe("abc-defg-hij");
    expect(meetingCodeOf("https://meet.google.com/lookup/some-code")).toBe("some-code");
  });

  it("returns null when the URL has no path", () => {
    expect(meetingCodeOf("https://meet.google.com/")).toBeNull();
    expect(meetingCodeOf("https://meet.google.com")).toBeNull();
  });
});

describe("buildSecrets", () => {
  it("always holds the meeting URL and its code", () => {
    expect(buildSecrets(sources())).toEqual([
      { label: "meeting URL", value: MEETING_URL },
      { label: "meeting code", value: "abc-defg-hij" },
    ]);
  });

  it("adds each credential that is set, as a substring secret", () => {
    const secrets = buildSecrets(
      sources({
        accountEmail: "bot@example.test",
        accountPassword: "pw-not-real",
        storageStateValue: "c3RhdGU=",
      })
    );

    expect(secrets).toEqual([
      { label: "meeting URL", value: MEETING_URL },
      { label: "meeting code", value: "abc-defg-hij" },
      { label: "account email", value: "bot@example.test" },
      { label: "account password", value: "pw-not-real" },
      { label: "storage state", value: "c3RhdGU=" },
    ]);
    for (const secret of secrets) expect("match" in secret).toBe(false);
  });

  it("adds every raw name as a whole-token secret when names are redacted", () => {
    const secrets = buildSecrets(sources({ rawNames: ["Ada Lovelace", "Grzegorz"] }));

    expect(secrets.slice(2)).toEqual([
      { label: "participant name", value: "Ada Lovelace", match: "token" },
      { label: "participant name", value: "Grzegorz", match: "token" },
    ]);
  });

  it("adds no name when names are kept raw on purpose", () => {
    const secrets = buildSecrets(sources({ redactNames: false, rawNames: ["Ada Lovelace"] }));

    expect(secrets.map((secret) => secret.label)).toEqual(["meeting URL", "meeting code"]);
  });

  it("leaves the code out when the URL has none", () => {
    expect(buildSecrets(sources({ meetingUrl: "https://meet.google.com/" }))).toEqual([
      { label: "meeting URL", value: "https://meet.google.com/" },
    ]);
  });
});

describe("name leak check on a report", () => {
  it("does not trip on a name whose word is part of the report's fixed text", () => {
    expect(
      nameLeaks(reportJson(["Participant A is speaking"]), [
        "Google Something",
        "Chrome Canary",
        "Participant Zero",
        "Completed Tasks",
        "Meet Probe",
        "Leave Call Button",
        "Ann Lee",
      ])
    ).toEqual([]);
  });

  it("trips on a whole raw name left in the output", () => {
    const json = reportJson(["Google Something is speaking"]);

    expect(nameLeaks(json, ["Google Something"])).toEqual(["participant name"]);
    expect(nameLeaks(reportJson(["name:Ada Lovelace"]), ["Ada Lovelace"])).toEqual(["participant name"]);
    expect(nameLeaks(reportJson(["Mute ADA LOVELACE's microphone"]), ["Ada Lovelace"])).toEqual([
      "participant name",
    ]);
  });

  it("matches a single-word name on token boundaries only", () => {
    expect(nameLeaks(reportJson(["Adapter metadata", "Annex channel"]), ["Ada", "Ann"])).toEqual([]);
    expect(nameLeaks(reportJson(["Grzegorzewski joined"]), ["Grzegorz"])).toEqual([]);
    expect(nameLeaks(reportJson(["Ada is speaking"]), ["Ada"])).toEqual(["participant name"]);
    expect(nameLeaks(reportJson(["(grzegorz)"]), ["Grzegorz"])).toEqual(["participant name"]);
  });

  it("handles non-ASCII names in any Unicode form", () => {
    const decomposed = "José Álvarez".normalize("NFD");

    expect(nameLeaks(reportJson([`${decomposed} is speaking`]), ["José Álvarez"])).toEqual([
      "participant name",
    ]);
    expect(nameLeaks(reportJson(["山田 太郎"]), ["山田 太郎"])).toEqual(["participant name"]);
    expect(nameLeaks(reportJson(["Łukasz Żółć 🚀 is muted"]), ["Łukasz Żółć 🚀"])).toEqual([
      "participant name",
    ]);
    expect(nameLeaks(reportJson(["Мария"]), ["Мария"])).toEqual(["participant name"]);
    expect(nameLeaks(reportJson(["Мариямна", "Zoëtrope"]), ["Мария", "Zoë"])).toEqual([]);
  });

  it("finds a name in its JSON-escaped form and next to an escaped control character", () => {
    expect(nameLeaks(reportJson(['Jean "JJ" O\'Neill is presenting']), ['Jean "JJ" O\'Neill'])).toEqual([
      "participant name",
    ]);
    expect(nameLeaks(reportJson(["Leave call\nAda Lovelace\tmuted"]), ["Ada Lovelace"])).toEqual([
      "participant name",
    ]);
    expect(nameLeaks(reportJson(["Ada\tLovelace"]), ["Ada Lovelace"])).toEqual(["participant name"]);
  });

  it("still finds the URL, the code and the credentials as substrings", () => {
    const secrets = buildSecrets(
      sources({ accountEmail: "bot@example.test", accountPassword: "pw-not-real" })
    );

    expect(findLeaks(reportJson([`x${MEETING_URL}x`]), secrets)).toEqual(["meeting URL", "meeting code"]);
    expect(findLeaks(reportJson(["xxabc-defg-hijxx"]), secrets)).toEqual(["meeting code"]);
    expect(findLeaks(reportJson(["mailto:bot@example.test.", "Xpw-not-realX"]), secrets)).toEqual([
      "account email",
      "account password",
    ]);
    expect(findLeaks(reportJson(), secrets)).toEqual([]);
  });
});

describe("terminalOutcomeOf", () => {
  it("maps the events that end a run", () => {
    expect(terminalOutcomeOf({ type: "denied" })).toBe("denied");
    expect(terminalOutcomeOf({ type: "removed" })).toBe("removed");
    expect(terminalOutcomeOf({ type: "meeting_ended" })).toBe("meeting_ended");
    expect(terminalOutcomeOf({ type: "connection_lost" })).toBe("connection_lost");
  });

  it("returns null for every other event", () => {
    const others: PlatformEvent[] = [
      { type: "waiting" },
      { type: "admitted" },
      { type: "participant_count", count: 3 },
      speaker("Ada"),
      { type: "source_activity", sourceKey: "s", level: 0.1 },
      { type: "source_identity", sourceKey: "s", participantId: "p", name: "Ada" },
    ];

    for (const event of others) expect(terminalOutcomeOf(event)).toBeNull();
  });
});

describe("resolveOutcome", () => {
  const state = (overrides: Partial<Parameters<typeof resolveOutcome>[0]> = {}) => ({
    joined: true,
    admitted: true,
    interrupted: false,
    terminal: null,
    ...overrides,
  });

  it("is completed after an admitted run that nothing ended", () => {
    expect(resolveOutcome(state())).toBe("completed");
  });

  it("is admit_timeout when the bot was never admitted", () => {
    expect(resolveOutcome(state({ admitted: false }))).toBe("admit_timeout");
  });

  it("is interrupted when a signal ended it, admitted or not", () => {
    expect(resolveOutcome(state({ interrupted: true }))).toBe("interrupted");
    expect(resolveOutcome(state({ interrupted: true, admitted: false }))).toBe("interrupted");
  });

  it("puts a terminal platform event before an interruption", () => {
    expect(resolveOutcome(state({ terminal: "removed", interrupted: true }))).toBe("removed");
    expect(resolveOutcome(state({ terminal: "denied", admitted: false }))).toBe("denied");
    expect(resolveOutcome(state({ terminal: "meeting_ended" }))).toBe("meeting_ended");
    expect(resolveOutcome(state({ terminal: "connection_lost" }))).toBe("connection_lost");
  });

  it("is join_failed whenever join rejected, whatever else happened", () => {
    expect(resolveOutcome(state({ joined: false, admitted: false }))).toBe("join_failed");
    expect(resolveOutcome(state({ joined: false, interrupted: true, terminal: "removed" }))).toBe(
      "join_failed"
    );
  });
});

describe("sweepKeysForTick", () => {
  it("sweeps every in-call selector on each fifth tick and the speaker selector on the others", () => {
    for (const tick of [0, 5, 10, 595]) expect(sweepKeysForTick(tick)).toBe(IN_CALL_SELECTOR_KEYS);
    for (const tick of [1, 2, 3, 4, 6, 9, 11]) expect(sweepKeysForTick(tick)).toEqual(["activeSpeakerName"]);
  });
});

describe("afterLeaveStep", () => {
  const observation = (observedMs: number): RawAfterLeaveObservation => ({
    observedMs,
    endedTextVisible: true,
    leaveCallButtonVisible: false,
    inMeetingMarkerVisible: false,
    dialogKeysVisible: [],
    urlKind: "meeting",
    msFromClickToEndedText: 400,
    samples: [],
  });

  const call = (method: RecordedPageCall["method"], tMs: number): RecordedPageCall => ({
    tMs,
    method,
    selectorKey: null,
    result: { kind: "void" },
    errorName: null,
    durationMs: 1,
  });

  it("returns null when nothing was observed after the leave", () => {
    expect(
      afterLeaveStep({
        leaveStartMs: 1000,
        leaveElapsedMs: 500,
        pageCalls: [call("close", 1400)],
        afterLeave: null,
      })
    ).toBeNull();
  });

  it("ends the step at the last close call", () => {
    expect(
      afterLeaveStep({
        leaveStartMs: 10_000,
        leaveElapsedMs: 4000,
        pageCalls: [call("click", 10_100), call("close", 900), call("close", 13_500)],
        afterLeave: observation(3000),
      })
    ).toEqual({ tMs: 10_500, label: "after-leave", durationMs: 3000 });
  });

  it("falls back to the moment leave returned when no close call was recorded", () => {
    expect(
      afterLeaveStep({
        leaveStartMs: 10_000,
        leaveElapsedMs: 4000,
        pageCalls: [call("click", 10_100)],
        afterLeave: observation(1500),
      })
    ).toEqual({ tMs: 12_500, label: "after-leave", durationMs: 1500 });
  });

  it("never starts the step before the leave itself", () => {
    expect(
      afterLeaveStep({
        leaveStartMs: 10_000,
        leaveElapsedMs: 4000,
        pageCalls: [call("close", 11_000)],
        afterLeave: observation(3000),
      })
    ).toEqual({ tMs: 10_000, label: "after-leave", durationMs: 3000 });
  });
});
