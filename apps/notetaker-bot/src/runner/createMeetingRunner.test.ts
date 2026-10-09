// @vitest-environment node
import type { NotetakerBotJoinRequest } from "@calcom/lib/notetaker/botContract";
import {
  NOTETAKER_SIGNATURE_HEADER,
  NOTETAKER_TIMESTAMP_HEADER,
  notetakerBotEventSchema,
  verifyNotetakerSignature,
} from "@calcom/lib/notetaker/botContract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerConfig } from "../config";
import type { Logger } from "../logger";
import { createSilentLogger } from "../logger";
import { FakePlatformAdapter } from "../platform/FakePlatformAdapter";
import type { PlatformEvent } from "../platform/PlatformAdapter";
import { FakeSpeechToTextProvider } from "../stt/FakeSpeechToTextProvider";
import type { SttUtterance } from "../stt/SpeechToTextProvider";
import { buildJoinRequest } from "../testing/httpTestKit";
import { createMeetingRunner } from "./createMeetingRunner";
import { createFakeMeeting, FAKE_MEETING_MIN_MS, FAKE_MEETING_TIMES, FAKE_PARTICIPANT } from "./fakeMeeting";
import type { RunnerStatus } from "./launcher/MeetingRunnerLauncher";
import type { RunnerEndSummary } from "./MeetingRunner";
import { MeetingRunner } from "./MeetingRunner";

type GoogleDeps = {
  browser: object;
  google: RunnerConfig["google"];
  chrome: RunnerConfig["chrome"];
  logger: Logger;
};
type TeamsDeps = { browser: object; chrome: RunnerConfig["chrome"]; logger: Logger };
type SonioxDeps = { apiKey: string; url?: string; model?: string; logger: Logger };
type LauncherDeps = { logger: Logger };

const captures = vi.hoisted(() => ({
  google: [] as GoogleDeps[],
  teams: [] as TeamsDeps[],
  soniox: [] as SonioxDeps[],
  launchers: [] as { instance: object; deps: LauncherDeps }[],
}));

vi.mock("../platform/GoogleMeetAdapter", () => ({
  GoogleMeetAdapter: class {
    constructor(deps: GoogleDeps) {
      captures.google.push(deps);
    }
  },
}));
vi.mock("../platform/MicrosoftTeamsAdapter", () => ({
  MicrosoftTeamsAdapter: class {
    constructor(deps: TeamsDeps) {
      captures.teams.push(deps);
    }
  },
}));
vi.mock("../platform/browser/PlaywrightChromeLauncher", () => ({
  PlaywrightChromeLauncher: class {
    constructor(deps: LauncherDeps) {
      captures.launchers.push({ instance: this, deps });
    }
  },
}));
vi.mock("../stt/SonioxRealtimeProvider", () => ({
  SonioxRealtimeProvider: class {
    constructor(deps: SonioxDeps) {
      captures.soniox.push(deps);
    }
  },
}));

const fakeConfig: RunnerConfig = {
  secret: "test-secret-not-real",
  adapterMode: "fake",
  fakeMeetingSeconds: 2,
  soniox: null,
  google: { joinMode: "guest", storageState: null, email: null, password: null },
  chrome: { channel: "chrome", headless: true },
  logLevel: "silent",
};
const realConfig: RunnerConfig = {
  ...fakeConfig,
  adapterMode: "real",
  soniox: { apiKey: "soniox-key-not-real", url: null, model: null },
};

type RecordedCall = { url: string; body: string; headers: Headers };

function createRecordingFetch(statusFor: (index: number) => number = () => 200) {
  const calls: RecordedCall[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const status = statusFor(calls.length);
    calls.push({ url: String(input), body, headers: new Headers(init?.headers) });
    return new Response('{"ok":true}', { status });
  };
  return { calls, fetchFn };
}

function parseEvents(calls: RecordedCall[]) {
  return calls.map((call) => notetakerBotEventSchema.parse(JSON.parse(call.body)));
}

const created: MeetingRunner[] = [];
let request: NotetakerBotJoinRequest;

function track(runner: MeetingRunner): MeetingRunner {
  created.push(runner);
  return runner;
}

function watchDone(runner: MeetingRunner): { current: () => RunnerEndSummary | null } {
  let summary: RunnerEndSummary | null = null;
  void runner.done.then((value) => {
    summary = value;
  });
  return { current: () => summary };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T10:00:00.000Z"));
  captures.google.length = 0;
  captures.teams.length = 0;
  captures.soniox.length = 0;
  captures.launchers.length = 0;
  created.length = 0;
  request = buildJoinRequest({ scheduledStartAt: new Date().toISOString() });
});

afterEach(async () => {
  for (const runner of created) runner.requestStop();
  await vi.advanceTimersByTimeAsync(10_000);
  vi.useRealTimers();
});

describe("createFakeMeeting", () => {
  type Recorded = { atMs: number; label: string };

  function startScript(meetingMs: number) {
    const { platform, stt } = createFakeMeeting({ platform: "GOOGLE_MEET", meetingMs });
    const log: Recorded[] = [];
    const utterances: SttUtterance[] = [];
    let audioFrames = 0;
    const startedAt = Date.now();
    const describeEvent = (event: PlatformEvent): string => {
      if (event.type === "participant_count") return `participant_count:${event.count}`;
      if (event.type === "speaker") return `speaker:${event.participantId}:${event.name}:${event.speaking}`;
      return event.type;
    };
    const ready = (async () => {
      await stt.start({
        onUtterance: (utterance) => {
          utterances.push(utterance);
          log.push({ atMs: Date.now() - startedAt, label: "utterance" });
        },
        onError: () => {},
      });
      await platform.join(
        { meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Notetaker" },
        {
          onEvent: (event) => log.push({ atMs: Date.now() - startedAt, label: describeEvent(event) }),
          onAudioFrame: () => {
            audioFrames += 1;
          },
        }
      );
    })();
    return { platform, stt, log, utterances, ready, audioFrames: () => audioFrames };
  }

  it("returns the fake adapters for the requested platform", () => {
    for (const name of ["GOOGLE_MEET", "MICROSOFT_TEAMS"] as const) {
      const { platform, stt } = createFakeMeeting({ platform: name, meetingMs: 2000 });
      expect(platform).toBeInstanceOf(FakePlatformAdapter);
      expect(platform.platform).toBe(name);
      expect(stt).toBeInstanceOf(FakeSpeechToTextProvider);
    }
  });

  it("emits nothing before join", async () => {
    const { platform, stt } = createFakeMeeting({ platform: "GOOGLE_MEET", meetingMs: 2000 });
    const events: string[] = [];
    await stt.start({ onUtterance: (utterance) => events.push(utterance.text), onError: () => {} });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([]);
    expect(platform.leaveCalls).toBe(0);
  });

  it("plays the scripted timeline exactly", async () => {
    const script = startScript(2000);
    await script.ready;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(script.log).toEqual([
      { atMs: FAKE_MEETING_TIMES.waitingMs, label: "waiting" },
      { atMs: FAKE_MEETING_TIMES.admittedMs, label: "admitted" },
      { atMs: FAKE_MEETING_TIMES.participantCountMs, label: "participant_count:2" },
      {
        atMs: FAKE_MEETING_TIMES.speakerStartMs,
        label: `speaker:${FAKE_PARTICIPANT.participantId}:${FAKE_PARTICIPANT.name}:true`,
      },
      {
        atMs: FAKE_MEETING_TIMES.speakerStopMs,
        label: `speaker:${FAKE_PARTICIPANT.participantId}:${FAKE_PARTICIPANT.name}:false`,
      },
      { atMs: FAKE_MEETING_TIMES.utterancesMs, label: "utterance" },
      { atMs: FAKE_MEETING_TIMES.utterancesMs, label: "utterance" },
      { atMs: 2000, label: "meeting_ended" },
    ]);
    expect(script.utterances).toHaveLength(2);
    expect(script.utterances[0]).toMatchObject({
      startMs: 20,
      endMs: 100,
      language: "en",
      diarizationLabel: "fake-speaker-2",
    });
    expect(script.utterances[1]).toMatchObject({
      startMs: 250,
      endMs: 350,
      language: "en",
      diarizationLabel: null,
    });
    expect(script.utterances[0]?.text).not.toBe(script.utterances[1]?.text);
    expect(script.audioFrames()).toBe(0);
  });

  it.each([200, 0, Number.NaN, -5])("raises a meeting length of %s to the minimum", async (meetingMs) => {
    const script = startScript(meetingMs);
    await script.ready;
    await vi.advanceTimersByTimeAsync(10_000);

    const ended = script.log.filter((entry) => entry.label === "meeting_ended");
    expect(ended).toEqual([{ atMs: FAKE_MEETING_MIN_MS, label: "meeting_ended" }]);
    expect(script.utterances).toHaveLength(2);
  });

  it("goes quiet after leave without throwing", async () => {
    const script = startScript(2000);
    await script.ready;
    await vi.advanceTimersByTimeAsync(350);
    const seen = script.log.length;
    await script.platform.leave();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(script.log).toHaveLength(seen);
    expect(script.utterances).toEqual([]);
  });

  it("drops utterances without throwing when the provider has not been started", async () => {
    const { platform } = createFakeMeeting({ platform: "GOOGLE_MEET", meetingMs: 2000 });
    const events: string[] = [];
    await platform.join(
      { meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Notetaker" },
      { onEvent: (event) => events.push(event.type), onAudioFrame: () => {} }
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toContain("meeting_ended");
  });
});

describe("createMeetingRunner", () => {
  it("runs a whole fake meeting through the signed callback", async () => {
    const { calls, fetchFn } = createRecordingFetch();
    const runner = track(
      createMeetingRunner({ request, config: fakeConfig, logger: createSilentLogger(), fetchFn })
    );
    const phases: RunnerStatus[] = [];
    runner.onStatusChange((status) => phases.push(status));
    const done = watchDone(runner);

    runner.start();
    await vi.advanceTimersByTimeAsync(2000 + 50);

    expect(done.current()).toEqual({ endReason: "MEETING_ENDED", passageCount: 2 });
    expect(calls).toHaveLength(5);
    for (const call of calls) expect(call.url).toBe(request.callbackUrl);

    const events = parseEvents(calls);
    expect(events.map((event) => event.type)).toEqual([
      "session.join_requested",
      "session.admitted",
      "session.notice_posted",
      "transcript.passages",
      "session.ended",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    for (const event of events) expect(event.sessionId).toBe(request.sessionId);

    for (const call of calls) {
      const input = {
        timestamp: call.headers.get(NOTETAKER_TIMESTAMP_HEADER),
        signature: call.headers.get(NOTETAKER_SIGNATURE_HEADER),
        rawBody: call.body,
      };
      expect(verifyNotetakerSignature({ secret: fakeConfig.secret, ...input })).toBe(true);
      expect(verifyNotetakerSignature({ secret: "another-secret", ...input })).toBe(false);
    }

    const passages = events.flatMap((event) =>
      event.type === "transcript.passages" ? event.data.passages : []
    );
    expect(passages).toHaveLength(2);
    expect(passages[0]).toMatchObject({
      speakerName: null,
      unknownSpeakerNumber: 1,
      speakerKey: "unknown:1",
      startMs: 20,
      endMs: 100,
    });
    expect(passages[1]).toMatchObject({
      speakerName: FAKE_PARTICIPANT.name,
      speakerKey: `participant:${FAKE_PARTICIPANT.participantId}`,
      unknownSpeakerNumber: null,
      startMs: 250,
      endMs: 350,
    });

    const ended = events[4];
    expect(ended?.type).toBe("session.ended");
    if (ended?.type === "session.ended") {
      expect(ended.data).toMatchObject({
        endReason: "MEETING_ENDED",
        interruptedAtMs: null,
        passageCount: 2,
        durationMs: 1700,
      });
    }

    const seenPhases = phases
      .map((status) => status.phase)
      .filter((phase, index, all) => index === 0 || phase !== all[index - 1]);
    expect(seenPhases).toEqual(["STARTING", "WAITING", "IN_MEETING", "ENDED"]);
    expect(phases[phases.length - 1]?.lastEventSequence).toBe(5);
  });

  it("builds none of the real collaborators in fake mode", () => {
    track(createMeetingRunner({ request, config: fakeConfig, logger: createSilentLogger() }));

    expect(captures.google).toHaveLength(0);
    expect(captures.teams).toHaveLength(0);
    expect(captures.soniox).toHaveLength(0);
    expect(captures.launchers).toHaveLength(0);
  });

  it("ends without a session.ended when the app answers 410", async () => {
    const { calls, fetchFn } = createRecordingFetch((index) => (index === 0 ? 200 : 410));
    const runner = track(
      createMeetingRunner({ request, config: fakeConfig, logger: createSilentLogger(), fetchFn })
    );
    const done = watchDone(runner);

    runner.start();
    await vi.advanceTimersByTimeAsync(400);
    expect(done.current()).toEqual({ endReason: null, passageCount: 0 });
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
    expect(parseEvents(calls).map((event) => event.type)).not.toContain("session.ended");
    expect(runner.getStatus()).toEqual({ phase: "ENDED", lastEventSequence: 1 });
  });

  it("ends after three refused signatures and sends nothing more", async () => {
    const { calls, fetchFn } = createRecordingFetch(() => 401);
    const runner = track(
      createMeetingRunner({ request, config: fakeConfig, logger: createSilentLogger(), fetchFn })
    );
    const done = watchDone(runner);

    runner.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(done.current()?.endReason).toBeNull();
    expect(calls).toHaveLength(3);
    expect(parseEvents(calls).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("reports STOP_REQUESTED once when stopped mid-meeting", async () => {
    const { calls, fetchFn } = createRecordingFetch();
    const runner = track(
      createMeetingRunner({ request, config: fakeConfig, logger: createSilentLogger(), fetchFn })
    );
    const done = watchDone(runner);

    runner.start();
    await vi.advanceTimersByTimeAsync(350);
    runner.requestStop();
    await vi.advanceTimersByTimeAsync(100);

    expect(done.current()?.endReason).toBe("STOP_REQUESTED");
    const events = parseEvents(calls);
    const last = events[events.length - 1];
    expect(last?.type).toBe("session.ended");
    if (last?.type === "session.ended") {
      expect(last.data.endReason).toBe("STOP_REQUESTED");
      expect(last.data.passageCount).toBe(0);
    }
    expect(events.map((event) => event.type)).not.toContain("transcript.passages");
    expect(events.filter((event) => event.type === "session.ended")).toHaveLength(1);

    const settled = calls.length;
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toHaveLength(settled);
  });

  it("wires the Google Meet adapter and the Soniox provider in real mode", () => {
    const logger = createSilentLogger();
    const runner = createMeetingRunner({ request, config: realConfig, logger });
    created.push(runner);

    expect(captures.launchers).toHaveLength(1);
    expect(captures.launchers[0]?.deps).toEqual({ logger });
    expect(captures.google).toHaveLength(1);
    expect(captures.google[0]?.google).toBe(realConfig.google);
    expect(captures.google[0]?.chrome).toBe(realConfig.chrome);
    expect(captures.google[0]?.browser).toBe(captures.launchers[0]?.instance);
    expect(captures.google[0]?.logger).toBe(logger);
    expect(captures.teams).toHaveLength(0);
    expect(captures.soniox).toHaveLength(1);
    expect(captures.soniox[0]?.apiKey).toBe("soniox-key-not-real");
    expect(captures.soniox[0]?.url).toBeUndefined();
    expect(captures.soniox[0]?.model).toBeUndefined();
    expect(runner).toBeInstanceOf(MeetingRunner);
    expect(runner.getStatus()).toEqual({ phase: "STARTING", lastEventSequence: 0 });
  });

  it("passes the Soniox url and model through", () => {
    const config: RunnerConfig = {
      ...realConfig,
      soniox: { apiKey: "soniox-key-not-real", url: "wss://stt.example.test/ws", model: "model-x" },
    };
    track(createMeetingRunner({ request, config, logger: createSilentLogger() }));

    expect(captures.soniox[0]?.url).toBe("wss://stt.example.test/ws");
    expect(captures.soniox[0]?.model).toBe("model-x");
  });

  it("wires the Microsoft Teams adapter for a Teams request", () => {
    const logger = createSilentLogger();
    const teamsRequest = buildJoinRequest({
      platform: "MICROSOFT_TEAMS",
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
    });
    track(createMeetingRunner({ request: teamsRequest, config: realConfig, logger }));

    expect(captures.teams).toHaveLength(1);
    expect(captures.teams[0]?.browser).toBe(captures.launchers[0]?.instance);
    expect(captures.teams[0]?.chrome).toBe(realConfig.chrome);
    expect(captures.teams[0]?.logger).toBe(logger);
    expect(captures.google).toHaveLength(0);
  });

  it("refuses real mode without a Soniox key and builds nothing", () => {
    const config: RunnerConfig = { ...realConfig, soniox: null };

    expect(() => createMeetingRunner({ request, config, logger: createSilentLogger() })).toThrow(
      /SONIOX_API_KEY/
    );
    expect(captures.google).toHaveLength(0);
    expect(captures.teams).toHaveLength(0);
    expect(captures.soniox).toHaveLength(0);
    expect(captures.launchers).toHaveLength(0);
  });
});
