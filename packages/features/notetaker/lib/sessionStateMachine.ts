import type { NotetakerOutcomeReasonDto, NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import type { NotetakerTranscriptCompletenessDto } from "@calcom/lib/dto/NotetakerTranscriptDto";
import type { NotetakerBotEndReason } from "@calcom/lib/notetaker/botContract";

const NOTETAKER_LIVE_SESSION_STATUSES: NotetakerSessionStatusDto[] = [
  "SCHEDULED",
  "WAITING_TO_BE_ADMITTED",
  "TRANSCRIBING",
  "PROCESSING",
];

const NOTETAKER_TERMINAL_SESSION_STATUSES: NotetakerSessionStatusDto[] = ["READY", "ENDED_EARLY", "FAILED"];

type NotetakerEndCause = NotetakerBotEndReason | "WATCHDOG_HEARTBEAT_LOSS";

type NotetakerOutcome =
  | { kind: "DELETE_SESSION" }
  | {
      kind: "OUTCOME";
      status: NotetakerSessionStatusDto;
      outcomeReason: NotetakerOutcomeReasonDto | null;
      completeness: NotetakerTranscriptCompletenessDto | null;
      normalised: boolean;
    };

type OutcomeCell = Extract<NotetakerOutcome, { kind: "OUTCOME" }>;
type OutcomeCellInput = Omit<OutcomeCell, "kind">;

const TRANSITIONS: Record<NotetakerSessionStatusDto, NotetakerSessionStatusDto[]> = {
  SCHEDULED: ["WAITING_TO_BE_ADMITTED", "TRANSCRIBING", "FAILED"],
  WAITING_TO_BE_ADMITTED: ["TRANSCRIBING", "FAILED"],
  TRANSCRIBING: ["PROCESSING"],
  PROCESSING: ["READY", "ENDED_EARLY", "FAILED"],
  READY: [],
  ENDED_EARLY: [],
  FAILED: [],
};

function canTransition(from: NotetakerSessionStatusDto, to: NotetakerSessionStatusDto): boolean {
  return TRANSITIONS[from].includes(to);
}

const failed = (outcomeReason: NotetakerOutcomeReasonDto, normalised = false): OutcomeCellInput => ({
  status: "FAILED",
  outcomeReason,
  completeness: null,
  normalised,
});

const endedEarly = (outcomeReason: NotetakerOutcomeReasonDto, normalised = false): OutcomeCellInput => ({
  status: "ENDED_EARLY",
  outcomeReason,
  completeness: "PARTIAL",
  normalised,
});

const ready = (normalised = false): OutcomeCellInput => ({
  status: "READY",
  outcomeReason: null,
  completeness: "COMPLETE",
  normalised,
});

const readyTruncated: OutcomeCellInput = {
  status: "READY",
  outcomeReason: "LENGTH_LIMIT_REACHED",
  completeness: "TRUNCATED",
  normalised: false,
};

// null is a pre-admission STOP_REQUESTED: the session row is deleted, not given an outcome.
type OutcomeRow = {
  beforeAdmission: OutcomeCellInput | null;
  withPassages: OutcomeCellInput;
  withoutPassages: OutcomeCellInput;
};

// Mirrors the "Outcome mapping" table in data-model.md; `normalised` marks cells where the
// app corrects an unexpected endReason/phase combination and the caller logs a warning.
const OUTCOME_MAPPING: Record<NotetakerEndCause, OutcomeRow> = {
  MEETING_ENDED: {
    beforeAdmission: failed("NOT_ADMITTED"),
    withPassages: ready(),
    withoutPassages: failed("NO_SPEECH_DETECTED"),
  },
  ALONE_TIMEOUT: {
    beforeAdmission: failed("MEETING_DID_NOT_START", true),
    withPassages: ready(),
    withoutPassages: failed("NO_SPEECH_DETECTED"),
  },
  NOT_ADMITTED: {
    beforeAdmission: failed("NOT_ADMITTED"),
    withPassages: endedEarly("INTERRUPTED", true),
    withoutPassages: failed("INTERRUPTED", true),
  },
  MEETING_DID_NOT_START: {
    beforeAdmission: failed("MEETING_DID_NOT_START"),
    withPassages: ready(true),
    withoutPassages: failed("MEETING_DID_NOT_START"),
  },
  REMOVED_BY_PARTICIPANT: {
    beforeAdmission: failed("REMOVED_BY_PARTICIPANT"),
    withPassages: endedEarly("REMOVED_BY_PARTICIPANT"),
    withoutPassages: failed("REMOVED_BY_PARTICIPANT"),
  },
  STOP_REQUESTED: {
    beforeAdmission: null,
    withPassages: endedEarly("STOPPED_BY_HOST"),
    withoutPassages: failed("STOPPED_BY_HOST"),
  },
  INTERRUPTED: {
    beforeAdmission: failed("INTERRUPTED"),
    withPassages: endedEarly("INTERRUPTED"),
    withoutPassages: failed("INTERRUPTED"),
  },
  LENGTH_LIMIT_REACHED: {
    beforeAdmission: failed("INTERRUPTED", true),
    withPassages: readyTruncated,
    withoutPassages: failed("NO_SPEECH_DETECTED"),
  },
  MEETING_LINK_UNUSABLE: {
    beforeAdmission: failed("MEETING_LINK_UNUSABLE"),
    withPassages: endedEarly("INTERRUPTED", true),
    withoutPassages: failed("INTERRUPTED", true),
  },
  WATCHDOG_HEARTBEAT_LOSS: {
    beforeAdmission: failed("INTERRUPTED"),
    withPassages: endedEarly("INTERRUPTED"),
    withoutPassages: failed("INTERRUPTED"),
  },
};

function mapOutcome(input: {
  cause: NotetakerEndCause;
  admitted: boolean;
  passageCount: number;
}): NotetakerOutcome {
  const row = OUTCOME_MAPPING[input.cause];
  if (!input.admitted) {
    return row.beforeAdmission ? { kind: "OUTCOME", ...row.beforeAdmission } : { kind: "DELETE_SESSION" };
  }
  return { kind: "OUTCOME", ...(input.passageCount > 0 ? row.withPassages : row.withoutPassages) };
}

function getProvisionalOutcomeReason(cause: NotetakerEndCause): NotetakerOutcomeReasonDto | null {
  return OUTCOME_MAPPING[cause].withPassages.outcomeReason;
}

function shouldBlockRejoin(input: { cause: NotetakerEndCause; admitted: boolean }): boolean {
  if (input.cause === "REMOVED_BY_PARTICIPANT") return true;
  return input.cause === "STOP_REQUESTED" && input.admitted;
}

function getDisplayedStatus(input: {
  choice: { enabled: boolean; pendingDispatch: boolean } | null;
  latestSessionStatus: NotetakerSessionStatusDto | null;
}): NotetakerSessionStatusDto | null {
  if (input.choice?.enabled && input.choice.pendingDispatch) return "SCHEDULED";
  return input.latestSessionStatus;
}

export {
  NOTETAKER_LIVE_SESSION_STATUSES,
  NOTETAKER_TERMINAL_SESSION_STATUSES,
  canTransition,
  mapOutcome,
  getProvisionalOutcomeReason,
  shouldBlockRejoin,
  getDisplayedStatus,
};
export type { NotetakerEndCause, NotetakerOutcome };
