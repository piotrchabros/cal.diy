// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ParticipantSample } from "./SpeakerAttribution";
import { PROVISIONAL_ATTRIBUTION_RULES, participantSpeakerKey, SpeakerAttributor } from "./SpeakerAttributor";

type Rules = ConstructorParameters<typeof SpeakerAttributor>[0];

const TEST_SALT = "test-salt";
const SALTED = { salt: TEST_SALT };

const ADA = { participantId: "p-ada", name: "Ada" };
const BEN = { participantId: "p-ben", name: "Ben" };

const named = (p: { participantId: string; name: string }, name?: string) => ({
  speakerKey: participantSpeakerKey(TEST_SALT, p.participantId),
  speakerName: name ?? p.name,
  unknownSpeakerNumber: null,
});

const unknown = (n: number) => ({
  speakerKey: `unknown:${n}`,
  speakerName: null,
  unknownSpeakerNumber: n,
});

const speakBetween = (
  attributor: SpeakerAttributor,
  p: { participantId: string; name: string },
  fromMs: number,
  toMs: number
): void => {
  attributor.recordSpeaker({ atMs: fromMs, ...p, speaking: true });
  attributor.recordSpeaker({ atMs: toMs, ...p, speaking: false });
};

const activity = (
  attributor: SpeakerAttributor,
  sourceKey: string,
  atMsList: number[],
  level = 0.5
): void => {
  for (const atMs of atMsList) {
    attributor.recordSourceActivity({ atMs, sourceKey, level });
  }
};

const identify = (
  attributor: SpeakerAttributor,
  sourceKey: string,
  p: { participantId: string; name: string }
): void => {
  attributor.recordSourceIdentity({ sourceKey, ...p });
};

const attribute = (
  attributor: SpeakerAttributor,
  startMs: number,
  endMs: number,
  diarizationLabel: string | null = "S1"
) => attributor.attribute({ startMs, endMs, diarizationLabel });

const U = (attributor: SpeakerAttributor) => attribute(attributor, 1000, 2000);

const ORDER_28_RULES: Rules = { signalOrder: ["UI_ACTIVE_SPEAKER", "CONTRIBUTING_SOURCE"] };

const setUp28 = (attributor: SpeakerAttributor): void => {
  identify(attributor, "csrc:1", ADA);
  activity(attributor, "csrc:1", [1000, 1500]);
  speakBetween(attributor, BEN, 1000, 2000);
};

describe("Rules constant", () => {
  it("exposes the provisional rules", () => {
    expect(PROVISIONAL_ATTRIBUTION_RULES).toEqual({
      signalOrder: ["CONTRIBUTING_SOURCE", "UI_ACTIVE_SPEAKER"],
      minOverlapRatio: 0.6,
      maxRunnerUpRatio: 0.3,
      sourceActivityHoldMs: 500,
      minSourceLevel: 0.05,
      retentionMs: 120000,
      minVoiceVotes: 3,
      minVoiceAgreement: 0.9,
      minLinkVotes: 12,
      minLinkShare: 0.8,
      maxIndicatorAgeMs: 1500,
      learnableSourcePrefix: "csrc:",
    });
  });

  it("partial rules do not mutate the constant", () => {
    new SpeakerAttributor({ signalOrder: ["UI_ACTIVE_SPEAKER"] }, SALTED);
    expect(PROVISIONAL_ATTRIBUTION_RULES).toEqual({
      signalOrder: ["CONTRIBUTING_SOURCE", "UI_ACTIVE_SPEAKER"],
      minOverlapRatio: 0.6,
      maxRunnerUpRatio: 0.3,
      sourceActivityHoldMs: 500,
      minSourceLevel: 0.05,
      retentionMs: 120000,
      minVoiceVotes: 3,
      minVoiceAgreement: 0.9,
      minLinkVotes: 12,
      minLinkShare: 0.8,
      maxIndicatorAgeMs: 1500,
      learnableSourcePrefix: "csrc:",
    });
  });
});

describe("UI active speaker", () => {
  it("names the one active speaker", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
  });

  it("still speaking with no closing sample", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordSpeaker({ atMs: 500, ...ADA, speaking: true });
    expect(U(a)).toEqual(named(ADA));
  });

  it("repeated true keeps the original start", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordSpeaker({ atMs: 0, ...ADA, speaking: true });
    a.recordSpeaker({ atMs: 900, ...ADA, speaking: true });
    a.recordSpeaker({ atMs: 1000, ...ADA, speaking: false });
    expect(attribute(a, 0, 1000)).toEqual(named(ADA));
  });

  it("false without an open interval is ignored", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordSpeaker({ atMs: 500, ...ADA, speaking: false });
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
    expect(attribute(a, 0, 500, null)).toEqual(unknown(1));
  });

  it("min overlap is inclusive", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 1600);
    expect(U(a)).toEqual(named(ADA));
  });

  it("just below min overlap", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 1599);
    expect(U(a)).toEqual(unknown(1));
  });

  it("runner-up limit is inclusive", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 2000);
    speakBetween(a, BEN, 1000, 1300);
    expect(U(a)).toEqual(named(ADA));
  });

  it("runner-up above the limit", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 2000);
    speakBetween(a, BEN, 1000, 1301);
    expect(U(a)).toEqual(unknown(1));
  });

  it("conflicting speakers are never guessed", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 1700);
    speakBetween(a, BEN, 1300, 2000);
    expect(U(a)).toEqual(unknown(1));
  });

  it("exact tie is silent even when the rules would allow it", () => {
    const rules: Rules = { maxRunnerUpRatio: 1 };
    const a = new SpeakerAttributor(rules, SALTED);
    speakBetween(a, ADA, 1000, 2000);
    speakBetween(a, BEN, 1000, 2000);
    expect(U(a)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor(rules, SALTED);
    speakBetween(fresh, ADA, 1000, 2000);
    speakBetween(fresh, BEN, 1000, 1900);
    expect(U(fresh)).toEqual(named(ADA));
  });

  it("zero-length utterance", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 2000);
    expect(attribute(a, 1500, 1500)).toEqual(named(ADA));
    expect(attribute(a, 1000, 1000)).toEqual(named(ADA));
    expect(attribute(a, 1999, 1999)).toEqual(named(ADA));
    expect(attribute(a, 2000, 2000, null)).toEqual(unknown(1));
  });

  it("reversed times count as zero-length at startMs", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1400, 1600);
    expect(a.attribute({ startMs: 1500, endMs: 1000, diarizationLabel: "S1" })).toEqual(named(ADA));
  });

  it("latest name wins, key stable", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
    a.recordSpeaker({ atMs: 3000, ...ADA, name: "Ada Lovelace", speaking: true });
    a.recordSpeaker({ atMs: 4000, ...ADA, name: "Ada Lovelace", speaking: false });
    expect(attribute(a, 3000, 4000)).toEqual(named(ADA, "Ada Lovelace"));
    expect(U(a)).toEqual(named(ADA, "Ada Lovelace"));
  });

  it("blank name never overwrites", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordSpeaker({ atMs: 1000, ...ADA, name: "Ada", speaking: true });
    a.recordSpeaker({ atMs: 2000, ...ADA, name: "  ", speaking: false });
    expect(U(a)).toEqual(named(ADA));
  });

  it("participant without a name is never named but still counts", () => {
    const nameless = { participantId: "p-x", name: "" };
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, nameless, 1000, 2000);
    expect(U(a)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor(undefined, SALTED);
    speakBetween(fresh, nameless, 1000, 2000);
    speakBetween(fresh, ADA, 1000, 1400);
    expect(U(fresh)).toEqual(unknown(1));
  });

  it("out-of-order false discards the open interval", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordSpeaker({ atMs: 1000, ...ADA, speaking: true });
    a.recordSpeaker({ atMs: 900, ...ADA, speaking: false });
    expect(U(a)).toEqual(unknown(1));
  });

  it("invalid samples are ignored", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordSpeaker({ atMs: Number.NaN, ...ADA, speaking: true });
    a.recordSpeaker({ atMs: 0, participantId: "", name: "Ghost", speaking: true });
    expect(attribute(a, 0, 1000, "S1")).toEqual(unknown(1));
  });
});

describe("Contributing source", () => {
  it("names from source activity", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1250, 1500, 1750]);
    expect(U(a)).toEqual(named(ADA));
  });

  it("overlapping hold windows are merged", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1050]);
    expect(U(a)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor(undefined, SALTED);
    identify(fresh, "csrc:1", ADA);
    activity(fresh, "csrc:1", [1000, 1100]);
    expect(U(fresh)).toEqual(named(ADA));
  });

  it("two keys of one participant are merged", () => {
    const a = new SpeakerAttributor({ sourceActivityHoldMs: 300 }, SALTED);
    identify(a, "csrc:1", ADA);
    identify(a, "csrc:2", BEN);
    identify(a, "ssrc:2", BEN);
    activity(a, "csrc:1", [1000, 1300, 1600, 1900]);
    activity(a, "csrc:2", [1000]);
    activity(a, "ssrc:2", [1000]);
    expect(U(a)).toEqual(named(ADA));
  });

  it("level threshold is inclusive", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1500], 0.05);
    expect(U(a)).toEqual(named(ADA));

    const fresh = new SpeakerAttributor(undefined, SALTED);
    identify(fresh, "csrc:1", ADA);
    activity(fresh, "csrc:1", [1000, 1500], 0.049);
    expect(U(fresh)).toEqual(unknown(1));
  });

  it("unmapped source is ignored", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    activity(a, "csrc:9", [1000, 1500]);
    expect(U(a)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor(undefined, SALTED);
    identify(fresh, "csrc:1", ADA);
    activity(fresh, "csrc:1", [1000, 1500]);
    activity(fresh, "csrc:9", [1000, 1500]);
    expect(U(fresh)).toEqual(named(ADA));
  });

  it("identity arriving after the samples", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    activity(a, "csrc:1", [1000, 1500]);
    expect(U(a)).toEqual(unknown(1));
    identify(a, "csrc:1", ADA);
    expect(U(a)).toEqual(named(ADA));
  });

  it("latest mapping and latest name win", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    identify(a, "csrc:1", ADA);
    identify(a, "csrc:1", BEN);
    activity(a, "csrc:1", [1000, 1500]);
    expect(U(a)).toEqual(named(BEN));

    const fresh = new SpeakerAttributor({ signalOrder: ["UI_ACTIVE_SPEAKER"] }, SALTED);
    speakBetween(fresh, ADA, 1000, 2000);
    fresh.recordSourceIdentity({ sourceKey: "csrc:7", participantId: "p-ada", name: "Ada L." });
    expect(U(fresh)).toEqual(named(ADA, "Ada L."));
  });

  it("NaN level and blank keys are ignored", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    identify(a, "csrc:1", ADA);
    a.recordSourceActivity({ atMs: 1000, sourceKey: "csrc:1", level: Number.NaN });
    a.recordSourceActivity({ atMs: 1000, sourceKey: "", level: 1 });
    a.recordSourceIdentity({ sourceKey: "", ...ADA });
    expect(U(a)).toEqual(unknown(1));
  });
});

describe("Order of signals", () => {
  it("contributing source takes precedence", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    setUp28(a);
    expect(U(a)).toEqual(named(ADA));
  });

  it("next signal is asked when the first is silent", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1050]);
    speakBetween(a, BEN, 1000, 2000);
    expect(U(a)).toEqual(named(BEN));
  });

  it("a conflict in the first signal does not block the second", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    identify(a, "csrc:1", ADA);
    identify(a, "csrc:2", BEN);
    activity(a, "csrc:1", [1000, 1500]);
    activity(a, "csrc:2", [1000, 1500]);
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
  });

  it("signalOrder is honoured", () => {
    const a = new SpeakerAttributor(ORDER_28_RULES, SALTED);
    setUp28(a);
    expect(U(a)).toEqual(named(BEN));
  });

  it("a signal left out is not used", () => {
    const a = new SpeakerAttributor({ signalOrder: ["UI_ACTIVE_SPEAKER"] }, SALTED);
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1500]);
    expect(U(a)).toEqual(unknown(1));

    const empty = new SpeakerAttributor({ signalOrder: [] }, SALTED);
    setUp28(empty);
    expect(U(empty)).toEqual(unknown(1));
  });

  it("speakerKey is stable across utterances and signals", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1500]);
    speakBetween(a, ADA, 3000, 4000);
    expect(U(a).speakerKey).toBe(participantSpeakerKey(TEST_SALT, "p-ada"));
    expect(attribute(a, 3000, 4000, "S9").speakerKey).toBe(participantSpeakerKey(TEST_SALT, "p-ada"));
  });
});

describe("Unknown speakers", () => {
  it("numbers from 1, the same label gets the same number", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    expect(attribute(a, 0, 100, "S7")).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "S2")).toEqual(unknown(2));
    expect(attribute(a, 0, 100, "S7")).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "S2")).toEqual(unknown(2));
  });

  it("no-label shared slot gets its own number on first use", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    expect(attribute(a, 0, 100, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "S1")).toEqual(unknown(2));
    expect(attribute(a, 0, 100, null)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor(undefined, SALTED);
    expect(attribute(fresh, 0, 100, "S1")).toEqual(unknown(1));
    expect(attribute(fresh, 0, 100, null)).toEqual(unknown(2));
    expect(attribute(fresh, 0, 100, null)).toEqual(unknown(2));
  });

  it("blank label uses the shared slot", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    expect(attribute(a, 0, 100, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "")).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "  ")).toEqual(unknown(1));
  });

  it("a number is allocated only when the speaker is unknown", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
    expect(attribute(a, 5000, 6000, "S2")).toEqual(unknown(1));
    expect(attribute(a, 7000, 8000, "S1")).toEqual(unknown(2));
  });

  it("no name is derived from a label or from history", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
    expect(attribute(a, 5000, 6000, "S1")).toEqual(unknown(1));
  });
});

describe("Retention", () => {
  it("drops intervals older than retention", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 }, SALTED);
    speakBetween(a, ADA, 0, 1000);
    expect(attribute(a, 0, 1000, null)).toEqual(named(ADA));
    expect(attribute(a, 5000, 6000, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 1000, null)).toEqual(unknown(1));
  });

  it("the boundary is kept, one past it is dropped", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 }, SALTED);
    speakBetween(a, ADA, 0, 1000);
    expect(attribute(a, 1500, 2000, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 1000, null)).toEqual(named(ADA));
    expect(attribute(a, 1500, 2001, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 1000, null)).toEqual(unknown(1));
  });

  it("source samples are dropped by the end of their hold", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 }, SALTED);
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [0, 500]);
    expect(attribute(a, 0, 1000, null)).toEqual(named(ADA));
    expect(attribute(a, 1900, 2000, null)).toEqual(unknown(1));
    expect(attribute(a, 500, 1000, null)).toEqual(named(ADA));
    expect(attribute(a, 0, 500, null)).toEqual(unknown(1));
  });

  it("an open interval is never dropped", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 }, SALTED);
    a.recordSpeaker({ atMs: 0, ...ADA, speaking: true });
    expect(attribute(a, 10000, 11000)).toEqual(named(ADA));
    expect(attribute(a, 500000, 501000)).toEqual(named(ADA));
  });

  it("identities, names and numbers survive pruning", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 }, SALTED);
    identify(a, "csrc:1", ADA);
    expect(attribute(a, 0, 1000, "S1")).toEqual(unknown(1));
    expect(attribute(a, 100000, 101000, "S2")).toEqual(unknown(2));
    activity(a, "csrc:1", [200000, 200500]);
    expect(attribute(a, 200000, 201000, "S1")).toEqual(named(ADA));
    expect(attribute(a, 300000, 301000, "S1")).toEqual(unknown(1));
  });
});

const CEL = { participantId: "p-cel", name: "Cel" };
const SELF = { participantId: "p-self", name: "You" };
const SOURCE_ONLY: Rules = { signalOrder: ["CONTRIBUTING_SOURCE"] };

const keyOf = (p: { participantId: string }) => participantSpeakerKey(TEST_SALT, p.participantId);

const tile = (
  p: { participantId: string; name: string },
  flags: { isSelf?: boolean; speakingNow?: boolean } = {}
): ParticipantSample => ({ ...p, isSelf: flags.isSelf ?? false, speakingNow: flags.speakingNow ?? false });

// One reading that marks only `p`, then `count` audible samples of every source, one millisecond apart.
const vote = (
  attributor: SpeakerAttributor,
  sourceKeys: string[],
  p: { participantId: string; name: string },
  count: number,
  fromMs: number
): void => {
  attributor.recordParticipants({
    atMs: fromMs,
    participants: [ADA, BEN, CEL].map((other) =>
      tile(other, { speakingNow: other.participantId === p.participantId })
    ),
  });
  for (let i = 0; i < count; i += 1) {
    for (const sourceKey of sourceKeys) {
      attributor.recordSourceActivity({ atMs: fromMs + i, sourceKey, level: 0.5 });
    }
  }
};

const links = (attributor: SpeakerAttributor) => Object.fromEntries(attributor.learnedLinks());

const linkAdaAndBen = (attributor: SpeakerAttributor): void => {
  vote(attributor, ["csrc:1"], ADA, 12, 0);
  vote(attributor, ["csrc:2"], BEN, 12, 100);
};

// Names one passage through the tile indicator, the simplest confident signal.
const confident = (
  attributor: SpeakerAttributor,
  p: { participantId: string; name: string },
  startMs: number,
  label: string | null
) => {
  speakBetween(attributor, p, startMs, startMs + 1000);
  return attribute(attributor, startMs, startMs + 1000, label);
};

describe("Speaker key", () => {
  it("is a prefix and 16 lower-case hex characters", () => {
    expect(participantSpeakerKey("salt", "p-ada")).toMatch(/^participant:[0-9a-f]{16}$/);
  });

  it("is the same for one id and salt, and differs for another salt or id", () => {
    expect(participantSpeakerKey("salt", "p-ada")).toBe(participantSpeakerKey("salt", "p-ada"));
    expect(participantSpeakerKey("salt", "p-ada")).not.toBe(participantSpeakerKey("other", "p-ada"));
    expect(participantSpeakerKey("salt", "p-ada")).not.toBe(participantSpeakerKey("salt", "p-ben"));
  });

  it("two attributors without a salt give different keys for one id", () => {
    const first = new SpeakerAttributor();
    const second = new SpeakerAttributor();
    speakBetween(first, ADA, 1000, 2000);
    speakBetween(second, ADA, 1000, 2000);
    const firstKey = U(first).speakerKey;
    expect(firstKey).toMatch(/^participant:[0-9a-f]{16}$/);
    expect(U(second).speakerKey).not.toBe(firstKey);
    expect(U(first).speakerKey).toBe(firstKey);
  });

  it("the raw participant id never appears in a returned key", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a).speakerKey).not.toContain("p-ada");
    attribute(a, 5000, 6000, "S7");
    speakBetween(a, ADA, 7000, 8000);
    speakBetween(a, ADA, 9000, 10000);
    attribute(a, 7000, 8000, "S7");
    attribute(a, 9000, 10000, "S7");
    attribute(a, 1000, 2000, "S7");
    expect(JSON.stringify(a.resolutions())).not.toContain("p-ada");
  });
});

describe("Link learning", () => {
  it("has no link at the start", () => {
    expect(links(new SpeakerAttributor(undefined, SALTED))).toEqual({});
  });

  it("no link while only one participant has votes, even with 100 votes", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:1"], ADA, 100, 0);
    expect(links(a)).toEqual({});
  });

  it("links once two participants each reached 12 votes", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:1"], ADA, 12, 0);
    vote(a, ["csrc:2"], BEN, 11, 100);
    expect(links(a)).toEqual({});
    vote(a, ["csrc:2"], BEN, 1, 200);
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben" });
  });

  it("a learned link names the passage", () => {
    const a = new SpeakerAttributor(SOURCE_ONLY, SALTED);
    linkAdaAndBen(a);
    activity(a, "csrc:2", [50000, 50500]);
    expect(attribute(a, 50000, 51000)).toEqual(named(BEN));
  });

  it("a share of exactly 0.8 links, and the link is dropped when later votes bring it under", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    linkAdaAndBen(a);
    vote(a, ["csrc:1"], BEN, 3, 200);
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben" });
    vote(a, ["csrc:1"], BEN, 1, 300);
    expect(links(a)).toEqual({ "csrc:2": "p-ben" });
  });

  it("a dropped link no longer names anyone", () => {
    const a = new SpeakerAttributor(SOURCE_ONLY, SALTED);
    linkAdaAndBen(a);
    activity(a, "csrc:1", [50000, 50500]);
    expect(attribute(a, 50000, 51000)).toEqual(named(ADA));
    vote(a, ["csrc:1"], BEN, 4, 60000);
    expect(attribute(a, 50000, 51000, "S9")).toEqual(unknown(1));
  });

  it("a source with equal presence for two participants never links", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:1", "csrc:9"], ADA, 20, 0);
    vote(a, ["csrc:2", "csrc:9"], BEN, 20, 100);
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben" });
  });

  it("a source heard with everybody does not link to the one who talked most", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:1", "csrc:9"], ADA, 80, 0);
    vote(a, ["csrc:2", "csrc:9"], BEN, 12, 100);
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben" });
  });

  it("a source heard with three participants never links", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:1", "csrc:9"], ADA, 40, 0);
    vote(a, ["csrc:2", "csrc:9"], BEN, 15, 100);
    vote(a, ["csrc:3", "csrc:9"], CEL, 25, 200);
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben", "csrc:3": "p-cel" });
  });

  it("a source with 11 votes does not link", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:1", "csrc:9"], ADA, 11, 0);
    vote(a, ["csrc:9"], ADA, 1, 50);
    vote(a, ["csrc:2", "csrc:9"], BEN, 12, 100);
    expect(links(a)).toEqual({ "csrc:2": "p-ben" });
  });

  it("an ssrc source never links", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:1", "ssrc:11"], ADA, 50, 0);
    vote(a, ["csrc:2", "ssrc:22"], BEN, 50, 100);
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben" });
  });

  it("the learnable prefix is a rule", () => {
    const a = new SpeakerAttributor({ learnableSourcePrefix: "ssrc:" }, SALTED);
    vote(a, ["csrc:1", "ssrc:11"], ADA, 12, 0);
    vote(a, ["csrc:2", "ssrc:22"], BEN, 12, 100);
    expect(links(a)).toEqual({ "ssrc:11": "p-ada", "ssrc:22": "p-ben" });
  });

  // Ben is established first. Twenty samples of csrc:1 are then sent under a condition that must not vote,
  // followed by 11 valid votes for Ada: had a single one of the twenty counted, Ada would reach 12 and link.
  const expectNoVote = (cast: (a: SpeakerAttributor, atMs: number) => void): void => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:2"], BEN, 12, 0);
    for (let i = 0; i < 20; i += 1) cast(a, 10000 + i * 2000);
    vote(a, ["csrc:1"], ADA, 11, 100000);
    expect(links(a)).toEqual({});
    vote(a, ["csrc:1"], ADA, 1, 100100);
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben" });
  };

  const sample = (a: SpeakerAttributor, atMs: number, level = 0.5): void =>
    a.recordSourceActivity({ atMs, sourceKey: "csrc:1", level });

  const adaMarked = (a: SpeakerAttributor, atMs: number): void =>
    a.recordParticipants({ atMs, participants: [tile(ADA, { speakingNow: true }), tile(BEN)] });

  it("no vote before any reading", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    for (let i = 0; i < 20; i += 1) sample(a, i);
    vote(a, ["csrc:2"], BEN, 12, 100);
    vote(a, ["csrc:1"], ADA, 11, 200);
    expect(links(a)).toEqual({});
  });

  it("no vote when the reading is older than 1500 ms", () => {
    expectNoVote((a, atMs) => {
      adaMarked(a, atMs);
      sample(a, atMs + 1501);
    });
  });

  it("a reading exactly 1500 ms old still votes", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:2"], BEN, 12, 0);
    adaMarked(a, 10000);
    for (let i = 0; i < 12; i += 1) sample(a, 11500);
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben" });
  });

  it("no vote when the reading is newer than the sample", () => {
    expectNoVote((a, atMs) => {
      adaMarked(a, atMs);
      sample(a, atMs - 1);
    });
  });

  it("no vote when two participants are marked", () => {
    expectNoVote((a, atMs) => {
      a.recordParticipants({
        atMs,
        participants: [tile(ADA, { speakingNow: true }), tile(BEN, { speakingNow: true })],
      });
      sample(a, atMs);
    });
  });

  it("no vote when nobody is marked", () => {
    expectNoVote((a, atMs) => {
      a.recordParticipants({ atMs, participants: [tile(ADA), tile(BEN)] });
      sample(a, atMs);
    });
  });

  it("no vote when the level is below 0.05", () => {
    expectNoVote((a, atMs) => {
      adaMarked(a, atMs);
      sample(a, atMs, 0.049);
    });
  });

  it("no vote after an empty reading replaced the one that marked somebody", () => {
    expectNoVote((a, atMs) => {
      adaMarked(a, atMs);
      a.recordParticipants({ atMs: atMs + 1, participants: [] });
      sample(a, atMs + 2);
    });
  });

  it("a reading with a non-finite time is ignored", () => {
    expectNoVote((a, atMs) => {
      a.recordParticipants({ atMs, participants: [tile(ADA), tile(BEN)] });
      adaMarked(a, Number.NaN);
      sample(a, atMs);
    });
  });

  it("no vote when the marked participant is self", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    vote(a, ["csrc:2"], BEN, 20, 0);
    vote(a, ["csrc:3"], CEL, 20, 100);
    a.recordParticipants({
      atMs: 200,
      participants: [tile(SELF, { isSelf: true, speakingNow: true }), tile(BEN), tile(CEL)],
    });
    for (let i = 0; i < 20; i += 1) sample(a, 200 + i);
    expect(links(a)).toEqual({ "csrc:2": "p-ben", "csrc:3": "p-cel" });
  });

  it("votes cast for a participant later flagged self stop counting", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    linkAdaAndBen(a);
    vote(a, ["csrc:3"], CEL, 12, 200);
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben", "csrc:3": "p-cel" });
    a.recordParticipants({ atMs: 300, participants: [tile(ADA, { isSelf: true }), tile(BEN), tile(CEL)] });
    expect(links(a)).toEqual({ "csrc:2": "p-ben", "csrc:3": "p-cel" });
  });

  it("an explicit source identity wins over a learned link", () => {
    const a = new SpeakerAttributor(SOURCE_ONLY, SALTED);
    linkAdaAndBen(a);
    identify(a, "csrc:1", CEL);
    activity(a, "csrc:1", [50000, 50500]);
    expect(attribute(a, 50000, 51000)).toEqual(named(CEL));
    expect(links(a)).toEqual({ "csrc:1": "p-ada", "csrc:2": "p-ben" });
  });
});

describe("Order of signals with a learned link", () => {
  const setUp = (a: SpeakerAttributor): void => {
    linkAdaAndBen(a);
    activity(a, "csrc:1", [50000, 50500]);
    speakBetween(a, BEN, 50000, 51000);
  };

  it("the source wins under the default order", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    setUp(a);
    expect(attribute(a, 50000, 51000)).toEqual(named(ADA));
  });

  it("the indicator wins under the reversed order", () => {
    const a = new SpeakerAttributor(ORDER_28_RULES, SALTED);
    setUp(a);
    expect(attribute(a, 50000, 51000)).toEqual(named(BEN));
  });
});

describe("Voice memory", () => {
  it("two confident attributions of a label do not name a signal-less passage, three do", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    expect(confident(a, ADA, 1000, "S1")).toEqual(named(ADA));
    expect(confident(a, ADA, 3000, "S1")).toEqual(named(ADA));
    expect(attribute(a, 20000, 21000, "S1")).toEqual(unknown(1));
    expect(confident(a, ADA, 5000, "S1")).toEqual(named(ADA));
    expect(attribute(a, 20000, 21000, "S1")).toEqual(named(ADA));
    expect(attribute(a, 20000, 21000, "S2")).toEqual(unknown(2));
  });

  const tallied = (adaCount: number, benCount: number): SpeakerAttributor => {
    const a = new SpeakerAttributor(undefined, SALTED);
    for (let i = 0; i < adaCount; i += 1)
      expect(confident(a, ADA, 1000 + i * 2000, "S1")).toEqual(named(ADA));
    for (let i = 0; i < benCount; i += 1)
      expect(confident(a, BEN, 40000 + i * 2000, "S1")).toEqual(named(BEN));
    return a;
  };

  it("at 9 of 10 agreement the voice is used", () => {
    expect(attribute(tallied(9, 1), 80000, 81000, "S1")).toEqual(named(ADA));
  });

  it("at 8 of 10 agreement the voice is not used", () => {
    expect(attribute(tallied(8, 2), 80000, 81000, "S1")).toEqual(unknown(1));
  });

  it("a passage named from the voice memory does not raise the tally", () => {
    const a = tallied(3, 0);
    for (let i = 0; i < 30; i += 1) {
      expect(attribute(a, 20000 + i * 100, 20100 + i * 100, "S1")).toEqual(named(ADA));
    }
    expect(confident(a, BEN, 40000, "S1")).toEqual(named(BEN));
    expect(attribute(a, 80000, 81000, "S1")).toEqual(unknown(1));
  });

  it("a blank or null label is never remembered", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    for (let i = 0; i < 5; i += 1) {
      expect(confident(a, ADA, 1000 + i * 4000, null)).toEqual(named(ADA));
      expect(confident(a, ADA, 3000 + i * 4000, "  ")).toEqual(named(ADA));
    }
    expect(attribute(a, 80000, 81000, null)).toEqual(unknown(1));
    expect(attribute(a, 80000, 81000, "  ")).toEqual(unknown(1));
    expect(attribute(a, 80000, 81000, "")).toEqual(unknown(1));
    expect(a.resolutions()).toEqual([]);
  });

  it("the thresholds are rules", () => {
    const a = new SpeakerAttributor({ minVoiceVotes: 1, minVoiceAgreement: 0.5 }, SALTED);
    expect(confident(a, ADA, 1000, "S1")).toEqual(named(ADA));
    expect(attribute(a, 20000, 21000, "S1")).toEqual(named(ADA));
  });

  it("an exact tie names nobody even when the rules would allow it", () => {
    const a = new SpeakerAttributor({ minVoiceVotes: 1, minVoiceAgreement: 0.5 }, SALTED);
    expect(confident(a, ADA, 1000, "S1")).toEqual(named(ADA));
    expect(confident(a, BEN, 3000, "S1")).toEqual(named(BEN));
    expect(attribute(a, 20000, 21000, "S1")).toEqual(unknown(1));
  });
});

describe("Resolutions", () => {
  it("is empty at the start", () => {
    expect(new SpeakerAttributor(undefined, SALTED).resolutions()).toEqual([]);
  });

  it("lists an unknown number once its label meets the thresholds", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    expect(attribute(a, 0, 500, "S1")).toEqual(unknown(1));
    confident(a, ADA, 1000, "S1");
    confident(a, ADA, 3000, "S1");
    expect(a.resolutions()).toEqual([]);
    confident(a, ADA, 5000, "S1");
    expect(a.resolutions()).toEqual([
      { speakerKey: "unknown:1", resolvedSpeakerKey: keyOf(ADA), speakerName: "Ada" },
    ]);
  });

  it("does not list a label that never had an unknown number", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    for (let i = 0; i < 3; i += 1) confident(a, ADA, 1000 + i * 2000, "S1");
    expect(a.resolutions()).toEqual([]);
  });

  it("never lists the no-label number", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    expect(attribute(a, 0, 500, null)).toEqual(unknown(1));
    for (let i = 0; i < 5; i += 1) confident(a, ADA, 1000 + i * 2000, null);
    expect(a.resolutions()).toEqual([]);
  });

  it("never lists self", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    expect(attribute(a, 0, 500, "S1")).toEqual(unknown(1));
    for (let i = 0; i < 3; i += 1) confident(a, ADA, 1000 + i * 2000, "S1");
    expect(a.resolutions()).toHaveLength(1);
    a.recordParticipants({ atMs: 9000, participants: [tile(ADA, { isSelf: true })] });
    expect(a.resolutions()).toEqual([]);
  });

  it("is sorted by number and lists each key once", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    expect(attribute(a, 0, 100, "S2")).toEqual(unknown(1));
    expect(attribute(a, 100, 200, null)).toEqual(unknown(2));
    expect(attribute(a, 200, 300, "S1")).toEqual(unknown(3));
    expect(attribute(a, 300, 400, "S3")).toEqual(unknown(4));
    for (let i = 0; i < 4; i += 1) confident(a, ADA, 1000 + i * 2000, "S1");
    for (let i = 0; i < 4; i += 1) confident(a, BEN, 20000 + i * 2000, "S2");
    const expected = [
      { speakerKey: "unknown:1", resolvedSpeakerKey: keyOf(BEN), speakerName: "Ben" },
      { speakerKey: "unknown:3", resolvedSpeakerKey: keyOf(ADA), speakerName: "Ada" },
    ];
    expect(a.resolutions()).toEqual(expected);
    expect(a.resolutions()).toEqual(expected);
  });
});

describe("Late evidence", () => {
  const unknownThenLinked = (rules: Rules): SpeakerAttributor => {
    const a = new SpeakerAttributor(rules, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(ADA), tile(BEN)] });
    for (const startMs of [1000, 2000, 3000]) {
      activity(a, "csrc:1", [startMs, startMs + 500]);
      expect(attribute(a, startMs, startMs + 1000, "S1")).toEqual(unknown(1));
    }
    expect(a.resolutions()).toEqual([]);
    vote(a, ["csrc:1"], ADA, 12, 10000);
    vote(a, ["csrc:2"], BEN, 12, 10100);
    return a;
  };

  it("passages attributed before the link existed are resolved after it is learned", () => {
    const a = unknownThenLinked(SOURCE_ONLY);
    expect(attribute(a, 30000, 31000, "S9")).toEqual(unknown(2));
    expect(a.resolutions()).toEqual([
      { speakerKey: "unknown:1", resolvedSpeakerKey: keyOf(ADA), speakerName: "Ada" },
    ]);
    expect(attribute(a, 40000, 41000, "S1")).toEqual(named(ADA));
  });

  it("resolutions alone also takes the late evidence into account", () => {
    const a = unknownThenLinked(SOURCE_ONLY);
    expect(a.resolutions()).toEqual([
      { speakerKey: "unknown:1", resolvedSpeakerKey: keyOf(ADA), speakerName: "Ada" },
    ]);
  });

  it("the passage that follows the link uses the re-evaluated windows", () => {
    const a = unknownThenLinked(SOURCE_ONLY);
    expect(attribute(a, 30000, 31000, "S1")).toEqual(named(ADA));
  });

  it("a re-evaluated window counts once", () => {
    const a = unknownThenLinked({ ...SOURCE_ONLY, minVoiceVotes: 4 });
    expect(a.resolutions()).toEqual([]);
    vote(a, ["csrc:1"], BEN, 4, 20000);
    vote(a, ["csrc:1"], ADA, 20, 20100);
    expect(a.resolutions()).toEqual([]);
  });

  it("a pending window older than retentionMs is not re-evaluated", () => {
    const a = unknownThenLinked({ ...SOURCE_ONLY, retentionMs: 5000 });
    expect(attribute(a, 30000, 31000, "S9")).toEqual(unknown(2));
    expect(a.resolutions()).toEqual([]);
  });

  it("a window without evidence stays pending and unknown", () => {
    const a = new SpeakerAttributor(SOURCE_ONLY, SALTED);
    for (const startMs of [1000, 2000, 3000]) {
      expect(attribute(a, startMs, startMs + 1000, "S1")).toEqual(unknown(1));
    }
    linkAdaAndBen(a);
    expect(attribute(a, 30000, 31000, "S1")).toEqual(unknown(1));
    expect(a.resolutions()).toEqual([]);
  });
});

describe("Duplicate names", () => {
  const ANNA_1 = { participantId: "p-1", name: "Anna Nowak" };
  const ANNA_2 = { participantId: "p-2", name: "Anna Nowak" };
  const ANNA_3 = { participantId: "p-3", name: "Anna Nowak" };

  it("numbers by first appearance, not by first speech", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(ANNA_1), tile(ANNA_2), tile(ANNA_3)] });
    expect(confident(a, ANNA_3, 1000, "S3")).toEqual(named(ANNA_3, "Anna Nowak (3)"));
    expect(confident(a, ANNA_2, 3000, "S2")).toEqual(named(ANNA_2, "Anna Nowak (2)"));
    expect(confident(a, ANNA_1, 5000, "S1")).toEqual(named(ANNA_1, "Anna Nowak"));
    expect(new Set([keyOf(ANNA_1), keyOf(ANNA_2), keyOf(ANNA_3)]).size).toBe(3);
  });

  it("names differing only in whitespace or compatibility form are one name", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({
      atMs: 0,
      participants: [tile(ANNA_1), tile({ participantId: "p-2", name: "  Anna   Nowak\t" })],
    });
    expect(confident(a, ANNA_2, 1000, "S2")).toEqual(named(ANNA_2, "Anna Nowak (2)"));
  });

  it("case is kept, so names differing in case are two names", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    const lower = { participantId: "p-2", name: "anna nowak" };
    a.recordParticipants({ atMs: 0, participants: [tile(ANNA_1), tile(lower)] });
    expect(confident(a, lower, 1000, "S2")).toEqual(named(lower, "anna nowak"));
  });

  it("the suffix of a participant never changes afterwards", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(ANNA_1), tile(ANNA_2)] });
    expect(confident(a, ANNA_2, 1000, "S2")).toEqual(named(ANNA_2, "Anna Nowak (2)"));
    a.recordParticipants({
      atMs: 2500,
      participants: [tile({ participantId: "p-1", name: "Anna Kowalska" }), tile(ANNA_2)],
    });
    expect(confident(a, ANNA_2, 3000, "S2")).toEqual(named(ANNA_2, "Anna Nowak (2)"));
    a.recordParticipants({ atMs: 4500, participants: [tile(ANNA_2)] });
    expect(confident(a, ANNA_2, 5000, "S2")).toEqual(named(ANNA_2, "Anna Nowak (2)"));
  });

  it("a renamed participant keeps its key and gets the new name", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(ANNA_1), tile(BEN)] });
    expect(confident(a, ANNA_1, 1000, "S1")).toEqual(named(ANNA_1, "Anna Nowak"));
    const renamed = { participantId: "p-1", name: "Ben" };
    a.recordParticipants({ atMs: 2500, participants: [tile(renamed), tile(BEN)] });
    expect(confident(a, renamed, 3000, "S1")).toEqual(named(ANNA_1, "Ben (2)"));
    expect(confident(a, BEN, 8000, "S2")).toEqual(named(BEN, "Ben"));
    a.recordParticipants({ atMs: 4500, participants: [tile(ANNA_1), tile(BEN)] });
    expect(confident(a, ANNA_1, 5000, "S1")).toEqual(named(ANNA_1, "Anna Nowak"));
  });

  it("a self tile with the same name takes no number", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({
      atMs: 0,
      participants: [tile({ participantId: "p-self", name: "Anna Nowak" }, { isSelf: true }), tile(ANNA_1)],
    });
    a.recordParticipants({
      atMs: 500,
      participants: [tile({ participantId: "p-self", name: "Anna Nowak" }), tile(ANNA_1), tile(ANNA_2)],
    });
    expect(confident(a, ANNA_1, 1000, "S1")).toEqual(named(ANNA_1, "Anna Nowak"));
    expect(confident(a, ANNA_2, 3000, "S2")).toEqual(named(ANNA_2, "Anna Nowak (2)"));
  });

  it("a 200-character name with a suffix is still at most 200 characters", () => {
    const long = "x".repeat(200);
    const first = { participantId: "p-1", name: long };
    const second = { participantId: "p-2", name: long };
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(first), tile(second)] });
    expect(confident(a, first, 1000, "S1").speakerName).toBe(long);
    expect(confident(a, second, 3000, "S2").speakerName).toBe(`${"x".repeat(196)} (2)`);
  });

  it("a longer name is cut to 200 characters without splitting a character", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    const tooLong = { participantId: "p-1", name: "x".repeat(250) };
    expect(confident(a, tooLong, 1000, "S1").speakerName).toBe("x".repeat(200));
    const astral = { participantId: "p-2", name: `${"x".repeat(199)}\u{1f600}tail` };
    expect(confident(a, astral, 3000, "S2").speakerName).toBe("x".repeat(199));
  });
});

describe("Self", () => {
  const selfSpeaks = (a: SpeakerAttributor, startMs: number): void => {
    speakBetween(a, SELF, startMs, startMs + 1000);
    identify(a, "csrc:7", SELF);
    activity(a, "csrc:7", [startMs, startMs + 500]);
  };

  it("a participant flagged self is never returned although both signals point at it", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(SELF, { isSelf: true }), tile(ADA)] });
    selfSpeaks(a, 1000);
    expect(U(a)).toEqual(unknown(1));
  });

  it("stays excluded after a later reading that does not flag it", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(SELF, { isSelf: true }), tile(ADA)] });
    a.recordParticipants({ atMs: 500, participants: [tile(SELF), tile(ADA)] });
    selfSpeaks(a, 1000);
    expect(U(a)).toEqual(unknown(1));
  });

  it("evidence recorded before the flag is dropped too", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    selfSpeaks(a, 1000);
    expect(U(a).speakerName).toBe("You");
    a.recordParticipants({ atMs: 3000, participants: [tile(SELF, { isSelf: true })] });
    expect(attribute(a, 1000, 2000, "S9")).toEqual(unknown(1));
  });

  it("does not stand in the way of the person who speaks", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(SELF, { isSelf: true }), tile(ADA)] });
    selfSpeaks(a, 1000);
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
  });

  it("an entry with an empty id is dropped", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({
      atMs: 0,
      participants: [
        tile({ participantId: "", name: "Ada" }, { isSelf: true, speakingNow: true }),
        tile(ADA),
      ],
    });
    expect(confident(a, ADA, 1000, "S1")).toEqual(named(ADA));
  });
});

describe("Names available", () => {
  it("is false at the start and after only unknown attributions", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    expect(a.namesAvailable()).toBe(false);
    attribute(a, 0, 1000, "S1");
    attribute(a, 1000, 2000, null);
    expect(a.namesAvailable()).toBe(false);
  });

  it("is false when participants were seen but nobody was named", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(ADA), tile(BEN)] });
    linkAdaAndBen(a);
    expect(a.namesAvailable()).toBe(false);
  });

  it("is true after one named attribution", () => {
    const a = new SpeakerAttributor(undefined, SALTED);
    confident(a, ADA, 1000, null);
    expect(a.namesAvailable()).toBe(true);
  });

  it("is true when only a resolution exists", () => {
    const a = new SpeakerAttributor(SOURCE_ONLY, SALTED);
    a.recordParticipants({ atMs: 0, participants: [tile(ADA), tile(BEN)] });
    for (const startMs of [1000, 2000, 3000]) {
      activity(a, "csrc:1", [startMs, startMs + 500]);
      expect(attribute(a, startMs, startMs + 1000, "S1")).toEqual(unknown(1));
    }
    expect(a.namesAvailable()).toBe(false);
    linkAdaAndBen(a);
    expect(a.namesAvailable()).toBe(true);
  });
});
