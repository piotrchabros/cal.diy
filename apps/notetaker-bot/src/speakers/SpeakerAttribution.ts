export type SpeakerAttribution = {
  speakerKey: string;
  speakerName: string | null;
  unknownSpeakerNumber: number | null;
};
export type AttributionSignal = "CONTRIBUTING_SOURCE" | "UI_ACTIVE_SPEAKER";
export interface ISpeakerAttributor {
  recordSpeaker(sample: { atMs: number; participantId: string; name: string; speaking: boolean }): void;
  recordSourceActivity(sample: { atMs: number; sourceKey: string; level: number }): void;
  recordSourceIdentity(identity: { sourceKey: string; participantId: string; name: string }): void;
  attribute(utterance: {
    startMs: number;
    endMs: number;
    diarizationLabel: string | null;
  }): SpeakerAttribution;
}
