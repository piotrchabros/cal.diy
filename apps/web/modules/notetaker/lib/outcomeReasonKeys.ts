import type { NotetakerOutcomeReasonDto } from "@calcom/lib/dto/NotetakerStateDto";

export const NOTETAKER_OUTCOME_REASON_KEYS: Record<NotetakerOutcomeReasonDto, string> = {
  NOT_ADMITTED: "notetaker_reason_not_admitted",
  MEETING_DID_NOT_START: "notetaker_reason_meeting_did_not_start",
  NO_SPEECH_DETECTED: "notetaker_reason_no_speech_detected",
  REMOVED_BY_PARTICIPANT: "notetaker_reason_removed_by_participant",
  STOPPED_BY_HOST: "notetaker_reason_stopped_by_host",
  INTERRUPTED: "notetaker_reason_interrupted",
  LENGTH_LIMIT_REACHED: "notetaker_reason_length_limit_reached",
  MEETING_LINK_UNUSABLE: "notetaker_reason_meeting_link_unusable",
};
