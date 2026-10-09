import { FakePlatformAdapter } from "../platform/FakePlatformAdapter";
import type { PlatformName } from "../platform/PlatformAdapter";
import { FakeSpeechToTextProvider } from "../stt/FakeSpeechToTextProvider";
import type { SttUtterance } from "../stt/SpeechToTextProvider";

// Larger delays make setTimeout fire at once.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Lies before the speaking interval, so attribution reports it as an unknown speaker.
const UNKNOWN_SPEAKER_UTTERANCE: SttUtterance = {
  startMs: 20,
  endMs: 100,
  text: "This is a scripted line from the fake meeting, spoken by nobody.",
  language: "en",
  diarizationLabel: "fake-speaker-2",
};

// Lies inside the speaking interval with margin on both sides, so it is attributed to the participant.
const NAMED_SPEAKER_UTTERANCE: SttUtterance = {
  startMs: 250,
  endMs: 350,
  text: "This is a second scripted line from the fake meeting.",
  language: "en",
  diarizationLabel: null,
};

function clampMeetingMs(meetingMs: number): number {
  if (!Number.isFinite(meetingMs)) return FAKE_MEETING_MIN_MS;
  return Math.min(Math.max(Math.round(meetingMs), FAKE_MEETING_MIN_MS), MAX_TIMER_DELAY_MS);
}

export const FAKE_MEETING_MIN_MS = 1000;

// Offsets from join. Everything after "admitted" is relative to the admission instant, so timer
// jitter cannot shift the speaker samples against the transcript clock, which starts at admission.
export const FAKE_MEETING_TIMES = {
  waitingMs: 0,
  admittedMs: 300,
  participantCountMs: 400,
  speakerStartMs: 450,
  speakerStopMs: 750,
  utterancesMs: 800,
} as const;

export const FAKE_PARTICIPANT = { participantId: "fake-participant-1", name: "Fake Participant" } as const;

export function createFakeMeeting(options: { platform: PlatformName; meetingMs: number }): {
  platform: FakePlatformAdapter;
  stt: FakeSpeechToTextProvider;
} {
  const stt = new FakeSpeechToTextProvider();
  const meetingMs = clampMeetingMs(options.meetingMs);

  // Unref'd so script timers left over after a stop cannot keep the runner process alive until the meeting length.
  const later = (delayMs: number, action: () => void): void => {
    setTimeout(action, delayMs).unref();
  };

  const schedule = (): void => {
    // The adapter throws on emit after leave, and a throw inside a timer would be an uncaught exception.
    const emit = (event: Parameters<FakePlatformAdapter["emit"]>[0]): void => {
      if (platform.leaveCalls > 0) return;
      platform.emit(event);
    };
    const speak = (utterance: SttUtterance): void => {
      if (platform.leaveCalls > 0) return;
      stt.emitUtterance(utterance);
    };

    later(FAKE_MEETING_TIMES.waitingMs, () => emit({ type: "waiting" }));
    later(FAKE_MEETING_TIMES.admittedMs, () => {
      emit({ type: "admitted" });
      const { admittedMs, participantCountMs, speakerStartMs, speakerStopMs, utterancesMs } =
        FAKE_MEETING_TIMES;
      later(participantCountMs - admittedMs, () => emit({ type: "participant_count", count: 2 }));
      later(speakerStartMs - admittedMs, () =>
        emit({ type: "speaker", ...FAKE_PARTICIPANT, speaking: true })
      );
      later(speakerStopMs - admittedMs, () =>
        emit({ type: "speaker", ...FAKE_PARTICIPANT, speaking: false })
      );
      later(utterancesMs - admittedMs, () => {
        speak(UNKNOWN_SPEAKER_UTTERANCE);
        speak(NAMED_SPEAKER_UTTERANCE);
      });
    });
    later(meetingMs, () => emit({ type: "meeting_ended" }));
  };

  const platform = new FakePlatformAdapter({ platform: options.platform, onJoined: schedule });
  return { platform, stt };
}
