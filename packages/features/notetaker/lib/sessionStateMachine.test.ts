import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerTranscriptCompletenessDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import { describe, expect, it } from "vitest";
import type { NotetakerEndCause, NotetakerOutcome } from "./sessionStateMachine";
import {
  canTransition,
  getDisplayedStatus,
  getProvisionalOutcomeReason,
  mapOutcome,
  NOTETAKER_LIVE_SESSION_STATUSES,
  NOTETAKER_TERMINAL_SESSION_STATUSES,
  shouldBlockRejoin,
} from "./sessionStateMachine";

const ALL_STATUSES: NotetakerSessionStatusDto[] = [
  "SCHEDULED",
  "WAITING_TO_BE_ADMITTED",
  "TRANSCRIBING",
  "PROCESSING",
  "READY",
  "ENDED_EARLY",
  "FAILED",
];

const ALL_CAUSES: NotetakerEndCause[] = [
  "MEETING_ENDED",
  "ALONE_TIMEOUT",
  "NOT_ADMITTED",
  "MEETING_DID_NOT_START",
  "REMOVED_BY_PARTICIPANT",
  "STOP_REQUESTED",
  "INTERRUPTED",
  "LENGTH_LIMIT_REACHED",
  "MEETING_LINK_UNUSABLE",
  "WATCHDOG_HEARTBEAT_LOSS",
];

const ALLOWED_PAIRS: [NotetakerSessionStatusDto, NotetakerSessionStatusDto][] = [
  ["SCHEDULED", "WAITING_TO_BE_ADMITTED"],
  ["SCHEDULED", "TRANSCRIBING"],
  ["SCHEDULED", "FAILED"],
  ["WAITING_TO_BE_ADMITTED", "TRANSCRIBING"],
  ["WAITING_TO_BE_ADMITTED", "FAILED"],
  ["TRANSCRIBING", "PROCESSING"],
  ["PROCESSING", "READY"],
  ["PROCESSING", "ENDED_EARLY"],
  ["PROCESSING", "FAILED"],
];

const ALL_PAIRS: [NotetakerSessionStatusDto, NotetakerSessionStatusDto][] = ALL_STATUSES.flatMap((from) =>
  ALL_STATUSES.map((to): [NotetakerSessionStatusDto, NotetakerSessionStatusDto] => [from, to])
);
const REFUSED_PAIRS = ALL_PAIRS.filter(
  ([from, to]) => !ALLOWED_PAIRS.some(([f, t]) => f === from && t === to)
);

describe("canTransition", () => {
  it.each(ALLOWED_PAIRS)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("refuses the other 40 of the 49 pairs", () => {
    expect(ALL_PAIRS).toHaveLength(49);
    expect(REFUSED_PAIRS).toHaveLength(40);
  });

  it.each(REFUSED_PAIRS)("refuses %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it.each(ALL_STATUSES)("refuses %s -> itself", (status) => {
    expect(canTransition(status, status)).toBe(false);
  });

  it("never leaves a terminal status", () => {
    expect(NOTETAKER_TERMINAL_SESSION_STATUSES).toEqual(["READY", "ENDED_EARLY", "FAILED"]);
    for (const from of NOTETAKER_TERMINAL_SESSION_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

describe("status groups", () => {
  it("lists the live statuses", () => {
    expect(NOTETAKER_LIVE_SESSION_STATUSES).toEqual([
      "SCHEDULED",
      "WAITING_TO_BE_ADMITTED",
      "TRANSCRIBING",
      "PROCESSING",
    ]);
  });

  it("keeps live and terminal disjoint and covering all seven statuses", () => {
    const live: string[] = NOTETAKER_LIVE_SESSION_STATUSES;
    const terminal: string[] = NOTETAKER_TERMINAL_SESSION_STATUSES;
    expect(live.filter((s) => terminal.includes(s))).toEqual([]);
    expect([...live, ...terminal].sort()).toEqual([...ALL_STATUSES].sort());
  });
});

type Cell = {
  status: "READY" | "ENDED_EARLY" | "FAILED";
  outcomeReason: NotetakerOutcomeReasonDto | null;
  completeness: NotetakerTranscriptCompletenessDto | null;
  normalised: boolean;
};

const out = (
  status: Cell["status"],
  outcomeReason: Cell["outcomeReason"],
  completeness: Cell["completeness"],
  normalised: boolean
): NotetakerOutcome => ({ kind: "OUTCOME", status, outcomeReason, completeness, normalised });

const DELETE: NotetakerOutcome = { kind: "DELETE_SESSION" };

// [cause, admitted, passageCount, expected]
const OUTCOME_TABLE: [NotetakerEndCause, boolean, number, NotetakerOutcome][] = [
  ["MEETING_ENDED", false, 0, out("FAILED", "NOT_ADMITTED", null, false)],
  ["MEETING_ENDED", true, 3, out("READY", null, "COMPLETE", false)],
  ["MEETING_ENDED", true, 0, out("FAILED", "NO_SPEECH_DETECTED", null, false)],
  ["ALONE_TIMEOUT", false, 0, out("FAILED", "MEETING_DID_NOT_START", null, true)],
  ["ALONE_TIMEOUT", true, 3, out("READY", null, "COMPLETE", false)],
  ["ALONE_TIMEOUT", true, 0, out("FAILED", "NO_SPEECH_DETECTED", null, false)],
  ["NOT_ADMITTED", false, 0, out("FAILED", "NOT_ADMITTED", null, false)],
  ["NOT_ADMITTED", true, 3, out("ENDED_EARLY", "INTERRUPTED", "PARTIAL", true)],
  ["NOT_ADMITTED", true, 0, out("FAILED", "INTERRUPTED", null, true)],
  ["MEETING_DID_NOT_START", false, 0, out("FAILED", "MEETING_DID_NOT_START", null, false)],
  ["MEETING_DID_NOT_START", true, 3, out("READY", null, "COMPLETE", true)],
  ["MEETING_DID_NOT_START", true, 0, out("FAILED", "MEETING_DID_NOT_START", null, false)],
  ["REMOVED_BY_PARTICIPANT", false, 0, out("FAILED", "REMOVED_BY_PARTICIPANT", null, false)],
  ["REMOVED_BY_PARTICIPANT", true, 3, out("ENDED_EARLY", "REMOVED_BY_PARTICIPANT", "PARTIAL", false)],
  ["REMOVED_BY_PARTICIPANT", true, 0, out("FAILED", "REMOVED_BY_PARTICIPANT", null, false)],
  ["STOP_REQUESTED", false, 0, DELETE],
  ["STOP_REQUESTED", true, 3, out("ENDED_EARLY", "STOPPED_BY_HOST", "PARTIAL", false)],
  ["STOP_REQUESTED", true, 0, out("FAILED", "STOPPED_BY_HOST", null, false)],
  ["INTERRUPTED", false, 0, out("FAILED", "INTERRUPTED", null, false)],
  ["INTERRUPTED", true, 3, out("ENDED_EARLY", "INTERRUPTED", "PARTIAL", false)],
  ["INTERRUPTED", true, 0, out("FAILED", "INTERRUPTED", null, false)],
  ["LENGTH_LIMIT_REACHED", false, 0, out("FAILED", "INTERRUPTED", null, true)],
  ["LENGTH_LIMIT_REACHED", true, 3, out("READY", "LENGTH_LIMIT_REACHED", "TRUNCATED", false)],
  ["LENGTH_LIMIT_REACHED", true, 0, out("FAILED", "NO_SPEECH_DETECTED", null, false)],
  ["MEETING_LINK_UNUSABLE", false, 0, out("FAILED", "MEETING_LINK_UNUSABLE", null, false)],
  ["MEETING_LINK_UNUSABLE", true, 3, out("ENDED_EARLY", "INTERRUPTED", "PARTIAL", true)],
  ["MEETING_LINK_UNUSABLE", true, 0, out("FAILED", "INTERRUPTED", null, true)],
  ["WATCHDOG_HEARTBEAT_LOSS", false, 0, out("FAILED", "INTERRUPTED", null, false)],
  ["WATCHDOG_HEARTBEAT_LOSS", true, 3, out("ENDED_EARLY", "INTERRUPTED", "PARTIAL", false)],
  ["WATCHDOG_HEARTBEAT_LOSS", true, 0, out("FAILED", "INTERRUPTED", null, false)],
];

describe("mapOutcome", () => {
  it("covers all 30 cells of the outcome mapping", () => {
    expect(OUTCOME_TABLE).toHaveLength(30);
  });

  it.each(OUTCOME_TABLE)("%s admitted=%s passages=%s", (cause, admitted, passageCount, expected) => {
    expect(mapOutcome({ cause, admitted, passageCount })).toEqual(expected);
  });

  it("ignores passageCount before admission", () => {
    expect(mapOutcome({ cause: "MEETING_ENDED", admitted: false, passageCount: 5 })).toEqual(
      out("FAILED", "NOT_ADMITTED", null, false)
    );
  });

  it("uses the at-least-1-passage column from one passage", () => {
    expect(mapOutcome({ cause: "MEETING_ENDED", admitted: true, passageCount: 1 })).toEqual(
      out("READY", null, "COMPLETE", false)
    );
  });

  it("keeps every outcome structurally consistent", () => {
    for (const [cause, admitted, passageCount] of OUTCOME_TABLE) {
      const result = mapOutcome({ cause, admitted, passageCount });
      if (result.kind === "DELETE_SESSION") continue;
      if (result.status === "FAILED") {
        expect(result.completeness).toBeNull();
        expect(result.outcomeReason).not.toBeNull();
      } else if (result.status === "ENDED_EARLY") {
        expect(result.completeness).toBe("PARTIAL");
        expect(result.outcomeReason).not.toBeNull();
      } else if (result.completeness === "TRUNCATED") {
        expect(result.outcomeReason).toBe("LENGTH_LIMIT_REACHED");
      } else {
        expect(result.outcomeReason).toBeNull();
      }
    }
  });

  it("only produces terminal statuses reachable from PROCESSING or an admission-less live status", () => {
    for (const [cause, admitted, passageCount] of OUTCOME_TABLE) {
      const result = mapOutcome({ cause, admitted, passageCount });
      if (result.kind === "DELETE_SESSION") continue;
      const terminal: string[] = NOTETAKER_TERMINAL_SESSION_STATUSES;
      expect(terminal).toContain(result.status);
      if (admitted) {
        expect(canTransition("PROCESSING", result.status)).toBe(true);
      } else {
        expect(canTransition("WAITING_TO_BE_ADMITTED", result.status)).toBe(true);
      }
    }
  });
});

describe("getProvisionalOutcomeReason", () => {
  it.each([
    ["MEETING_ENDED", null],
    ["ALONE_TIMEOUT", null],
    ["NOT_ADMITTED", "INTERRUPTED"],
    ["MEETING_DID_NOT_START", null],
    ["REMOVED_BY_PARTICIPANT", "REMOVED_BY_PARTICIPANT"],
    ["STOP_REQUESTED", "STOPPED_BY_HOST"],
    ["INTERRUPTED", "INTERRUPTED"],
    ["LENGTH_LIMIT_REACHED", "LENGTH_LIMIT_REACHED"],
    ["MEETING_LINK_UNUSABLE", "INTERRUPTED"],
    ["WATCHDOG_HEARTBEAT_LOSS", "INTERRUPTED"],
  ] as [NotetakerEndCause, string | null][])("%s gives %s", (cause, expected) => {
    expect(getProvisionalOutcomeReason(cause)).toBe(expected);
  });

  it.each(ALL_CAUSES)("%s equals the at-least-1-passage column of mapOutcome", (cause) => {
    const result = mapOutcome({ cause, admitted: true, passageCount: 1 });
    expect(result.kind).toBe("OUTCOME");
    if (result.kind === "OUTCOME") {
      expect(getProvisionalOutcomeReason(cause)).toBe(result.outcomeReason);
    }
  });
});

describe("shouldBlockRejoin", () => {
  it.each([true, false])("blocks REMOVED_BY_PARTICIPANT when admitted=%s", (admitted) => {
    expect(shouldBlockRejoin({ cause: "REMOVED_BY_PARTICIPANT", admitted })).toBe(true);
  });

  it("blocks STOP_REQUESTED only after admission", () => {
    expect(shouldBlockRejoin({ cause: "STOP_REQUESTED", admitted: true })).toBe(true);
    expect(shouldBlockRejoin({ cause: "STOP_REQUESTED", admitted: false })).toBe(false);
  });

  const others = ALL_CAUSES.filter((c) => c !== "REMOVED_BY_PARTICIPANT" && c !== "STOP_REQUESTED");
  it.each(
    others.flatMap((cause) =>
      [true, false].map((admitted): [NotetakerEndCause, boolean] => [cause, admitted])
    )
  )("does not block %s when admitted=%s", (cause, admitted) => {
    expect(shouldBlockRejoin({ cause, admitted })).toBe(false);
  });
});

describe("getDisplayedStatus", () => {
  it("shows SCHEDULED for an enabled pending choice without a session", () => {
    expect(
      getDisplayedStatus({ choice: { enabled: true, pendingDispatch: true }, latestSessionStatus: null })
    ).toBe("SCHEDULED");
  });

  it("shows SCHEDULED when re-armed after a terminal session", () => {
    expect(
      getDisplayedStatus({ choice: { enabled: true, pendingDispatch: true }, latestSessionStatus: "FAILED" })
    ).toBe("SCHEDULED");
  });

  it("shows the latest session status when not pending", () => {
    expect(
      getDisplayedStatus({
        choice: { enabled: true, pendingDispatch: false },
        latestSessionStatus: "TRANSCRIBING",
      })
    ).toBe("TRANSCRIBING");
  });

  it("shows the latest session status whatever enabled is", () => {
    expect(
      getDisplayedStatus({ choice: { enabled: false, pendingDispatch: false }, latestSessionStatus: "READY" })
    ).toBe("READY");
  });

  it("does not treat pendingDispatch alone as enough", () => {
    expect(
      getDisplayedStatus({ choice: { enabled: false, pendingDispatch: true }, latestSessionStatus: "READY" })
    ).toBe("READY");
  });

  it("shows the latest session status without a choice", () => {
    expect(getDisplayedStatus({ choice: null, latestSessionStatus: "ENDED_EARLY" })).toBe("ENDED_EARLY");
  });

  it("shows null without a choice or session", () => {
    expect(getDisplayedStatus({ choice: null, latestSessionStatus: null })).toBeNull();
  });

  it("shows null for an enabled, not pending choice without a session", () => {
    expect(
      getDisplayedStatus({ choice: { enabled: true, pendingDispatch: false }, latestSessionStatus: null })
    ).toBeNull();
  });
});
