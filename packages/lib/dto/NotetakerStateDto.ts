import type { NotetakerSummaryDto } from "./NotetakerSummaryDto";
import type { NotetakerTranscriptDto } from "./NotetakerTranscriptDto";

export type NotetakerSessionStatusDto =
  | "SCHEDULED"
  | "WAITING_TO_BE_ADMITTED"
  | "TRANSCRIBING"
  | "PROCESSING"
  | "READY"
  | "ENDED_EARLY"
  | "FAILED";

export type NotetakerOutcomeReasonDto =
  | "NOT_ADMITTED"
  | "MEETING_DID_NOT_START"
  | "NO_SPEECH_DETECTED"
  | "REMOVED_BY_PARTICIPANT"
  | "STOPPED_BY_HOST"
  | "INTERRUPTED"
  | "LENGTH_LIMIT_REACHED"
  | "MEETING_LINK_UNUSABLE";

export type NotetakerPlatformDto = "GOOGLE_MEET" | "MICROSOFT_TEAMS";

export type NotetakerChoiceSourceDto = "HOST" | "EVENT_TYPE_DEFAULT";

export type NotetakerBotProviderDto = "SELF_HOSTED" | "RECALL" | "FAKE";

export type NotetakerIneligibilityReasonDto =
  | "FEATURE_DISABLED"
  | "UNSUPPORTED_PLATFORM"
  | "CAL_VIDEO"
  | "IN_PERSON_OR_PHONE"
  | "NO_MEETING_LINK"
  | "BOOKING_NOT_ACTIVE"
  | "MEETING_ENDED"
  | "REJOIN_BLOCKED";

export type NotetakerStateDto = {
  bookingUid: string;
  featureEnabled: boolean;
  viewerRole: "HOST" | "ATTENDEE";
  eligibility: {
    eligible: boolean;
    platform: NotetakerPlatformDto | null;
    reason: NotetakerIneligibilityReasonDto | null;
  };
  choice: {
    enabled: boolean;
    source: NotetakerChoiceSourceDto;
    appliedToSeries: boolean;
    setByName: string | null;
    setAt: string;
  } | null;
  status: NotetakerSessionStatusDto | null;
  canToggle: boolean;
  canStop: boolean;
  isRecurring: boolean;
  session: {
    id: string;
    status: NotetakerSessionStatusDto;
    outcomeReason: NotetakerOutcomeReasonDto | null;
    startedLate: boolean;
    joinRequestedAt: string | null;
    admittedAt: string | null;
    endedAt: string | null;
    interruptedAtMs: number | null;
    resultsDeletedAt: string | null;
  } | null;
  transcript: NotetakerTranscriptDto | null;
  summary: NotetakerSummaryDto | null;
  sharedWithAttendees: boolean;
};

export type NotetakerEventTypeDefaultDto = {
  enabledByDefault: boolean;
  available: boolean;
  /** Only FEATURE_DISABLED, UNSUPPORTED_PLATFORM or CAL_VIDEO apply to an event type. */
  unavailableReason: NotetakerIneligibilityReasonDto | null;
};

export type NotetakerDisclosureDto = {
  enabledByDefault: boolean;
  onBehalfOf: string | null;
  supportedLocationTypes: string[];
};
