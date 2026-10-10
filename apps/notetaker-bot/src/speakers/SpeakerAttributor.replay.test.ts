// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AttributionRules } from "./SpeakerAttributor";
import { participantSpeakerKey, SpeakerAttributor } from "./SpeakerAttributor";

// A replay shaped like the speech measurement of 2026-10-10: two people speak in turns, each has a contributing
// and a synchronization source of their own, one contributing source is audible with both, the instantaneous
// tile indicator is seen on a minority of polls and the sustained one trails after a turn.

const SALT = "replay-salt";
const A = { participantId: "tile-1", name: "Anna Nowak", label: "S1", csrc: "csrc:1", ssrc: "ssrc:11" };
const B = { participantId: "tile-2", name: "Bartek Lis", label: "S2", csrc: "csrc:2", ssrc: "ssrc:22" };
const SELF = { participantId: "tile-3", name: "You" };
const COMMON_SOURCE = "csrc:9";

type Person = typeof A;
type Turn = { person: Person; startMs: number; endMs: number; round: 1 | 2 };

const TURNS: Turn[] = [
  { person: A, startMs: 10000, endMs: 30000, round: 1 },
  { person: B, startMs: 30000, endMs: 50000, round: 1 },
  { person: A, startMs: 60000, endMs: 80000, round: 2 },
  { person: B, startMs: 80000, endMs: 100000, round: 2 },
];

const END_MS = 120000;
const SOURCE_INTERVAL_MS = 250;
const POLL_INTERVAL_MS = 600;
const PASSAGE_MS = 5000;
const CHECKPOINT_MS = 5000;
const INDICATOR_DELAY_MS = 600;
const INDICATOR_HOLD_MS = 3000;
const SPURIOUS_INDICATOR = { person: A, startMs: 2000, endMs: 8000 };

type Step = { atMs: number; order: number; run: (attributor: SpeakerAttributor) => void };
type Passage = { turn: Turn; startMs: number; speakerKey: string; speakerName: string | null };
type ReplayOptions = {
  rules?: Partial<AttributionRules>;
  sustainedIndicatorInSecondRound?: boolean;
  pollOffsetMs?: number;
  speakingNowPhase?: number;
};

function turnAt(atMs: number): Turn | null {
  for (const turn of TURNS) {
    if (atMs >= turn.startMs && atMs < turn.endMs) return turn;
  }
  return null;
}

function sourceSteps(): Step[] {
  const steps: Step[] = [];
  for (const turn of TURNS) {
    let index = 0;
    for (let atMs = turn.startMs; atMs < turn.endMs; atMs += SOURCE_INTERVAL_MS) {
      // Instantaneous levels are sparse: every third sample of a speaker's own sources reads as quiet.
      const ownLevel = index % 3 === 2 ? 0.01 : 0.5;
      index += 1;
      steps.push({
        atMs,
        order: 1,
        run: (attributor) => {
          attributor.recordSourceActivity({ atMs, sourceKey: turn.person.csrc, level: ownLevel });
          attributor.recordSourceActivity({ atMs, sourceKey: turn.person.ssrc, level: ownLevel });
          attributor.recordSourceActivity({ atMs, sourceKey: COMMON_SOURCE, level: 0.5 });
        },
      });
    }
  }
  return steps;
}

function pollSteps(offsetMs: number, phase: number): Step[] {
  const steps: Step[] = [];
  let index = 0;
  for (let atMs = offsetMs; atMs <= END_MS; atMs += POLL_INTERVAL_MS) {
    const speaker = index % 4 === phase ? (turnAt(atMs)?.person ?? null) : null;
    index += 1;
    steps.push({
      atMs,
      order: 0,
      run: (attributor) =>
        attributor.recordParticipants({
          atMs,
          participants: [
            { participantId: A.participantId, name: A.name, isSelf: false, speakingNow: speaker === A },
            { participantId: B.participantId, name: B.name, isSelf: false, speakingNow: speaker === B },
            { participantId: SELF.participantId, name: SELF.name, isSelf: true, speakingNow: false },
          ],
        }),
    });
  }
  return steps;
}

function indicatorStep(person: Person, atMs: number, speaking: boolean): Step {
  return {
    atMs,
    // A tile that stops is reported before the tile that starts, as the adapter does.
    order: speaking ? 3 : 2,
    run: (attributor) =>
      attributor.recordSpeaker({ atMs, participantId: person.participantId, name: person.name, speaking }),
  };
}

function sustainedSteps(inSecondRound: boolean): Step[] {
  const steps: Step[] = [
    indicatorStep(SPURIOUS_INDICATOR.person, SPURIOUS_INDICATOR.startMs, true),
    indicatorStep(SPURIOUS_INDICATOR.person, SPURIOUS_INDICATOR.endMs, false),
  ];
  TURNS.forEach((turn, index) => {
    if (turn.round === 2 && !inSecondRound) return;
    const next = TURNS[index + 1];
    const isFollowedAtOnce = next !== undefined && next.startMs === turn.endMs;
    const offMs = isFollowedAtOnce ? next.startMs + INDICATOR_DELAY_MS : turn.endMs + INDICATOR_HOLD_MS;
    steps.push(indicatorStep(turn.person, turn.startMs + INDICATOR_DELAY_MS, true));
    steps.push(indicatorStep(turn.person, offMs, false));
  });
  return steps;
}

function replay(options: ReplayOptions = {}) {
  const attributor = new SpeakerAttributor(options.rules, { salt: SALT });
  const steps = [
    ...sourceSteps(),
    ...pollSteps(options.pollOffsetMs ?? 0, options.speakingNowPhase ?? 0),
    ...sustainedSteps(options.sustainedIndicatorInSecondRound ?? true),
  ].sort((a, b) => a.atMs - b.atMs || a.order - b.order);

  const utterances = TURNS.flatMap((turn) => {
    const starts: number[] = [];
    for (let startMs = turn.startMs; startMs < turn.endMs; startMs += PASSAGE_MS) starts.push(startMs);
    return starts.map((startMs) => ({ turn, startMs, endMs: startMs + PASSAGE_MS }));
  });

  const passages: Passage[] = [];
  const checkpoints: { atMs: number; links: Record<string, string> }[] = [];
  let nextStep = 0;
  let nextUtterance = 0;
  for (let nowMs = 0; nowMs <= END_MS; nowMs += SOURCE_INTERVAL_MS / 5) {
    for (let step = steps[nextStep]; step !== undefined && step.atMs <= nowMs; step = steps[nextStep]) {
      step.run(attributor);
      nextStep += 1;
    }
    // A passage is attributed when it ends, as the timeline advances, never with knowledge of the future.
    for (
      let utterance = utterances[nextUtterance];
      utterance !== undefined && utterance.endMs <= nowMs;
      utterance = utterances[nextUtterance]
    ) {
      const attribution = attributor.attribute({
        startMs: utterance.startMs,
        endMs: utterance.endMs,
        diarizationLabel: utterance.turn.person.label,
      });
      passages.push({
        turn: utterance.turn,
        startMs: utterance.startMs,
        speakerKey: attribution.speakerKey,
        speakerName: attribution.speakerName,
      });
      nextUtterance += 1;
    }
    if (nowMs % CHECKPOINT_MS === 0) {
      checkpoints.push({ atMs: nowMs, links: Object.fromEntries(attributor.learnedLinks()) });
    }
  }
  return { attributor, passages, checkpoints };
}

const keyOf = (person: { participantId: string }) => participantSpeakerKey(SALT, person.participantId);
const round = (passages: Passage[], number: 1 | 2) => passages.filter((p) => p.turn.round === number);
const namesOf = (passages: Passage[]) => passages.map((p) => p.speakerName);
const trueNamesOf = (passages: Passage[]) => passages.map((p) => p.turn.person.name);

function expectNoWrongName(passages: Passage[]): void {
  for (const passage of passages) {
    const at = `passage at ${passage.startMs} ms`;
    if (passage.speakerName === null) {
      expect(passage.speakerKey, at).toMatch(/^unknown:\d+$/);
      continue;
    }
    expect(passage.speakerName, at).toBe(passage.turn.person.name);
    expect(passage.speakerKey, at).toBe(keyOf(passage.turn.person));
  }
}

function expectOnlyOwnContributingSourcesLinked(
  checkpoints: { atMs: number; links: Record<string, string> }[]
) {
  const allowed: Record<string, string> = { [A.csrc]: A.participantId, [B.csrc]: B.participantId };
  for (const checkpoint of checkpoints) {
    const at = `links at ${checkpoint.atMs} ms`;
    expect(checkpoint.links, at).not.toHaveProperty([COMMON_SOURCE]);
    expect(checkpoint.links, at).not.toHaveProperty([A.ssrc]);
    expect(checkpoint.links, at).not.toHaveProperty([B.ssrc]);
    for (const [sourceKey, participantId] of Object.entries(checkpoint.links)) {
      expect(participantId, `${at}, source ${sourceKey}`).toBe(allowed[sourceKey]);
    }
  }
}

describe("replay of the 2026-10-10 measurement", () => {
  it("is the timeline the assertions assume", () => {
    const { passages, checkpoints } = replay();
    expect(passages).toHaveLength(16);
    expect(round(passages, 1)).toHaveLength(8);
    expect(round(passages, 2)).toHaveLength(8);
    expect(checkpoints).toHaveLength(END_MS / CHECKPOINT_MS + 1);
  });

  it("gives every passage the true speaker's name or none", () => {
    const { passages } = replay();
    expectNoWrongName(passages);
    expect(passages.some((passage) => passage.speakerName !== null)).toBe(true);
  });

  it("names every passage of the second round", () => {
    const { passages } = replay();
    expect(namesOf(round(passages, 2))).toEqual(trueNamesOf(round(passages, 2)));
  });

  it("never links the common source or a synchronization source", () => {
    const { checkpoints } = replay();
    expectOnlyOwnContributingSourcesLinked(checkpoints);
    expect(checkpoints[0]?.links).toEqual({});
  });

  it("has no link while only one person has spoken", () => {
    const { checkpoints } = replay();
    for (const checkpoint of checkpoints) {
      if (checkpoint.atMs > 30000) continue;
      expect(checkpoint.links, `links at ${checkpoint.atMs} ms`).toEqual({});
    }
  });

  it("ends with exactly each speaker's own contributing source linked", () => {
    const { attributor, checkpoints } = replay();
    const expected = { [A.csrc]: A.participantId, [B.csrc]: B.participantId };
    expect(Object.fromEntries(attributor.learnedLinks())).toEqual(expected);
    // Learned by the start of the second round, and never lost again.
    for (const checkpoint of checkpoints) {
      if (checkpoint.atMs < 60000) continue;
      expect(checkpoint.links, `links at ${checkpoint.atMs} ms`).toEqual(expected);
    }
  });

  it("never returns the self tile", () => {
    const { attributor, passages } = replay();
    const selfKey = keyOf(SELF);
    for (const passage of passages) {
      expect(passage.speakerName).not.toBe(SELF.name);
      expect(passage.speakerKey).not.toBe(selfKey);
    }
    expect([...attributor.learnedLinks().values()]).not.toContain(SELF.participantId);
    expect(JSON.stringify(attributor.resolutions())).not.toContain(selfKey);
  });

  it("reports names as available", () => {
    expect(replay().attributor.namesAvailable()).toBe(true);
  });

  describe("variant 1: no sustained indicator in the second round", () => {
    // The voice memory is switched off so that only the learned source can name a second-round passage.
    const options: ReplayOptions = {
      sustainedIndicatorInSecondRound: false,
      rules: { minVoiceVotes: Number.POSITIVE_INFINITY },
    };

    it("still names every passage of the second round", () => {
      const { passages } = replay(options);
      expect(namesOf(round(passages, 2))).toEqual(trueNamesOf(round(passages, 2)));
      expectNoWrongName(passages);
    });

    it("names them with the default rules too", () => {
      const { passages } = replay({ sustainedIndicatorInSecondRound: false });
      expect(namesOf(round(passages, 2))).toEqual(trueNamesOf(round(passages, 2)));
      expectNoWrongName(passages);
    });

    it("links the same sources", () => {
      const { attributor, checkpoints } = replay(options);
      expectOnlyOwnContributingSourcesLinked(checkpoints);
      expect(Object.fromEntries(attributor.learnedLinks())).toEqual({
        [A.csrc]: A.participantId,
        [B.csrc]: B.participantId,
      });
    });
  });

  describe("variant 2: the contributing source is the only signal", () => {
    const options: ReplayOptions = { rules: { signalOrder: ["CONTRIBUTING_SOURCE"] } };

    // Nothing can link while only A has spoken, so A's first turn stays unknown. B's own source reaches its
    // twelfth vote in the last quarter of B's first turn, so the last passage of that turn is already named.
    it("leaves the first round unknown until both links are learned, one number per voice", () => {
      const { passages, checkpoints } = replay(options);
      expect(round(passages, 1).map((p) => p.speakerKey)).toEqual([
        "unknown:1",
        "unknown:1",
        "unknown:1",
        "unknown:1",
        "unknown:2",
        "unknown:2",
        "unknown:2",
        keyOf(B),
      ]);
      expect(checkpoints.find((checkpoint) => checkpoint.atMs === 45000)?.links).not.toHaveProperty([B.csrc]);
      expect(checkpoints.find((checkpoint) => checkpoint.atMs === 50000)?.links).toHaveProperty([B.csrc]);
    });

    it("names every passage of the second round", () => {
      const { passages } = replay(options);
      expect(namesOf(round(passages, 2))).toEqual(trueNamesOf(round(passages, 2)));
      expectNoWrongName(passages);
    });

    it("resolves both unknown numbers to the right people", () => {
      const { attributor } = replay(options);
      expect(attributor.resolutions()).toEqual([
        { speakerKey: "unknown:1", resolvedSpeakerKey: keyOf(A), speakerName: A.name },
        { speakerKey: "unknown:2", resolvedSpeakerKey: keyOf(B), speakerName: B.name },
      ]);
      expect(attributor.namesAvailable()).toBe(true);
    });
  });

  // The measurement fixes neither where the tile polls fall relative to the audio samples nor which polls catch
  // the instantaneous indicator, so no wrong name may depend on either.
  describe("every alignment of the tile polls", () => {
    const alignments: { pollOffsetMs: number; speakingNowPhase: number }[] = [];
    for (let pollOffsetMs = 0; pollOffsetMs < POLL_INTERVAL_MS; pollOffsetMs += 50) {
      for (let speakingNowPhase = 0; speakingNowPhase < 4; speakingNowPhase += 1) {
        alignments.push({ pollOffsetMs, speakingNowPhase });
      }
    }
    const orders: AttributionRules["signalOrder"][] = [
      ["CONTRIBUTING_SOURCE", "UI_ACTIVE_SPEAKER"],
      ["CONTRIBUTING_SOURCE"],
    ];

    it("gives zero wrong names and never links the common source", () => {
      for (const signalOrder of orders) {
        for (const alignment of alignments) {
          const { attributor, passages, checkpoints } = replay({ ...alignment, rules: { signalOrder } });
          expectNoWrongName(passages);
          expectOnlyOwnContributingSourcesLinked(checkpoints);
          expectOnlyOwnContributingSourcesLinked([
            { atMs: END_MS, links: Object.fromEntries(attributor.learnedLinks()) },
          ]);
          for (const resolution of attributor.resolutions()) {
            const person = resolution.speakerKey === "unknown:1" ? A : B;
            expect(resolution.resolvedSpeakerKey).toBe(keyOf(person));
            expect(resolution.speakerName).toBe(person.name);
          }
        }
      }
    });
  });
});
