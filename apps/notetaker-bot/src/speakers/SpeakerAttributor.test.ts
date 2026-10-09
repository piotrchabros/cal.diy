// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PROVISIONAL_ATTRIBUTION_RULES, SpeakerAttributor } from "./SpeakerAttributor";

type Rules = ConstructorParameters<typeof SpeakerAttributor>[0];

const ADA = { participantId: "p-ada", name: "Ada" };
const BEN = { participantId: "p-ben", name: "Ben" };

const named = (p: { participantId: string; name: string }, name?: string) => ({
  speakerKey: `participant:${p.participantId}`,
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
    });
  });

  it("partial rules do not mutate the constant", () => {
    new SpeakerAttributor({ signalOrder: ["UI_ACTIVE_SPEAKER"] });
    expect(PROVISIONAL_ATTRIBUTION_RULES).toEqual({
      signalOrder: ["CONTRIBUTING_SOURCE", "UI_ACTIVE_SPEAKER"],
      minOverlapRatio: 0.6,
      maxRunnerUpRatio: 0.3,
      sourceActivityHoldMs: 500,
      minSourceLevel: 0.05,
      retentionMs: 120000,
    });
  });
});

describe("UI active speaker", () => {
  it("names the one active speaker", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
  });

  it("still speaking with no closing sample", () => {
    const a = new SpeakerAttributor();
    a.recordSpeaker({ atMs: 500, ...ADA, speaking: true });
    expect(U(a)).toEqual(named(ADA));
  });

  it("repeated true keeps the original start", () => {
    const a = new SpeakerAttributor();
    a.recordSpeaker({ atMs: 0, ...ADA, speaking: true });
    a.recordSpeaker({ atMs: 900, ...ADA, speaking: true });
    a.recordSpeaker({ atMs: 1000, ...ADA, speaking: false });
    expect(attribute(a, 0, 1000)).toEqual(named(ADA));
  });

  it("false without an open interval is ignored", () => {
    const a = new SpeakerAttributor();
    a.recordSpeaker({ atMs: 500, ...ADA, speaking: false });
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
    expect(attribute(a, 0, 500, null)).toEqual(unknown(1));
  });

  it("min overlap is inclusive", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 1600);
    expect(U(a)).toEqual(named(ADA));
  });

  it("just below min overlap", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 1599);
    expect(U(a)).toEqual(unknown(1));
  });

  it("runner-up limit is inclusive", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 2000);
    speakBetween(a, BEN, 1000, 1300);
    expect(U(a)).toEqual(named(ADA));
  });

  it("runner-up above the limit", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 2000);
    speakBetween(a, BEN, 1000, 1301);
    expect(U(a)).toEqual(unknown(1));
  });

  it("conflicting speakers are never guessed", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 1700);
    speakBetween(a, BEN, 1300, 2000);
    expect(U(a)).toEqual(unknown(1));
  });

  it("exact tie is silent even when the rules would allow it", () => {
    const rules: Rules = { maxRunnerUpRatio: 1 };
    const a = new SpeakerAttributor(rules);
    speakBetween(a, ADA, 1000, 2000);
    speakBetween(a, BEN, 1000, 2000);
    expect(U(a)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor(rules);
    speakBetween(fresh, ADA, 1000, 2000);
    speakBetween(fresh, BEN, 1000, 1900);
    expect(U(fresh)).toEqual(named(ADA));
  });

  it("zero-length utterance", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 2000);
    expect(attribute(a, 1500, 1500)).toEqual(named(ADA));
    expect(attribute(a, 1000, 1000)).toEqual(named(ADA));
    expect(attribute(a, 1999, 1999)).toEqual(named(ADA));
    expect(attribute(a, 2000, 2000, null)).toEqual(unknown(1));
  });

  it("reversed times count as zero-length at startMs", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1400, 1600);
    expect(a.attribute({ startMs: 1500, endMs: 1000, diarizationLabel: "S1" })).toEqual(named(ADA));
  });

  it("latest name wins, key stable", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
    a.recordSpeaker({ atMs: 3000, ...ADA, name: "Ada Lovelace", speaking: true });
    a.recordSpeaker({ atMs: 4000, ...ADA, name: "Ada Lovelace", speaking: false });
    expect(attribute(a, 3000, 4000)).toEqual(named(ADA, "Ada Lovelace"));
    expect(U(a)).toEqual(named(ADA, "Ada Lovelace"));
  });

  it("blank name never overwrites", () => {
    const a = new SpeakerAttributor();
    a.recordSpeaker({ atMs: 1000, ...ADA, name: "Ada", speaking: true });
    a.recordSpeaker({ atMs: 2000, ...ADA, name: "  ", speaking: false });
    expect(U(a)).toEqual(named(ADA));
  });

  it("participant without a name is never named but still counts", () => {
    const nameless = { participantId: "p-x", name: "" };
    const a = new SpeakerAttributor();
    speakBetween(a, nameless, 1000, 2000);
    expect(U(a)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor();
    speakBetween(fresh, nameless, 1000, 2000);
    speakBetween(fresh, ADA, 1000, 1400);
    expect(U(fresh)).toEqual(unknown(1));
  });

  it("out-of-order false discards the open interval", () => {
    const a = new SpeakerAttributor();
    a.recordSpeaker({ atMs: 1000, ...ADA, speaking: true });
    a.recordSpeaker({ atMs: 900, ...ADA, speaking: false });
    expect(U(a)).toEqual(unknown(1));
  });

  it("invalid samples are ignored", () => {
    const a = new SpeakerAttributor();
    a.recordSpeaker({ atMs: Number.NaN, ...ADA, speaking: true });
    a.recordSpeaker({ atMs: 0, participantId: "", name: "Ghost", speaking: true });
    expect(attribute(a, 0, 1000, "S1")).toEqual(unknown(1));
  });
});

describe("Contributing source", () => {
  it("names from source activity", () => {
    const a = new SpeakerAttributor();
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1250, 1500, 1750]);
    expect(U(a)).toEqual(named(ADA));
  });

  it("overlapping hold windows are merged", () => {
    const a = new SpeakerAttributor();
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1050]);
    expect(U(a)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor();
    identify(fresh, "csrc:1", ADA);
    activity(fresh, "csrc:1", [1000, 1100]);
    expect(U(fresh)).toEqual(named(ADA));
  });

  it("two keys of one participant are merged", () => {
    const a = new SpeakerAttributor({ sourceActivityHoldMs: 300 });
    identify(a, "csrc:1", ADA);
    identify(a, "csrc:2", BEN);
    identify(a, "ssrc:2", BEN);
    activity(a, "csrc:1", [1000, 1300, 1600, 1900]);
    activity(a, "csrc:2", [1000]);
    activity(a, "ssrc:2", [1000]);
    expect(U(a)).toEqual(named(ADA));
  });

  it("level threshold is inclusive", () => {
    const a = new SpeakerAttributor();
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1500], 0.05);
    expect(U(a)).toEqual(named(ADA));

    const fresh = new SpeakerAttributor();
    identify(fresh, "csrc:1", ADA);
    activity(fresh, "csrc:1", [1000, 1500], 0.049);
    expect(U(fresh)).toEqual(unknown(1));
  });

  it("unmapped source is ignored", () => {
    const a = new SpeakerAttributor();
    activity(a, "csrc:9", [1000, 1500]);
    expect(U(a)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor();
    identify(fresh, "csrc:1", ADA);
    activity(fresh, "csrc:1", [1000, 1500]);
    activity(fresh, "csrc:9", [1000, 1500]);
    expect(U(fresh)).toEqual(named(ADA));
  });

  it("identity arriving after the samples", () => {
    const a = new SpeakerAttributor();
    activity(a, "csrc:1", [1000, 1500]);
    expect(U(a)).toEqual(unknown(1));
    identify(a, "csrc:1", ADA);
    expect(U(a)).toEqual(named(ADA));
  });

  it("latest mapping and latest name win", () => {
    const a = new SpeakerAttributor();
    identify(a, "csrc:1", ADA);
    identify(a, "csrc:1", BEN);
    activity(a, "csrc:1", [1000, 1500]);
    expect(U(a)).toEqual(named(BEN));

    const fresh = new SpeakerAttributor({ signalOrder: ["UI_ACTIVE_SPEAKER"] });
    speakBetween(fresh, ADA, 1000, 2000);
    fresh.recordSourceIdentity({ sourceKey: "csrc:7", participantId: "p-ada", name: "Ada L." });
    expect(U(fresh)).toEqual(named(ADA, "Ada L."));
  });

  it("NaN level and blank keys are ignored", () => {
    const a = new SpeakerAttributor();
    identify(a, "csrc:1", ADA);
    a.recordSourceActivity({ atMs: 1000, sourceKey: "csrc:1", level: Number.NaN });
    a.recordSourceActivity({ atMs: 1000, sourceKey: "", level: 1 });
    a.recordSourceIdentity({ sourceKey: "", ...ADA });
    expect(U(a)).toEqual(unknown(1));
  });
});

describe("Order of signals", () => {
  it("contributing source takes precedence", () => {
    const a = new SpeakerAttributor();
    setUp28(a);
    expect(U(a)).toEqual(named(ADA));
  });

  it("next signal is asked when the first is silent", () => {
    const a = new SpeakerAttributor();
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1050]);
    speakBetween(a, BEN, 1000, 2000);
    expect(U(a)).toEqual(named(BEN));
  });

  it("a conflict in the first signal does not block the second", () => {
    const a = new SpeakerAttributor();
    identify(a, "csrc:1", ADA);
    identify(a, "csrc:2", BEN);
    activity(a, "csrc:1", [1000, 1500]);
    activity(a, "csrc:2", [1000, 1500]);
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
  });

  it("signalOrder is honoured", () => {
    const a = new SpeakerAttributor(ORDER_28_RULES);
    setUp28(a);
    expect(U(a)).toEqual(named(BEN));
  });

  it("a signal left out is not used", () => {
    const a = new SpeakerAttributor({ signalOrder: ["UI_ACTIVE_SPEAKER"] });
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1500]);
    expect(U(a)).toEqual(unknown(1));

    const empty = new SpeakerAttributor({ signalOrder: [] });
    setUp28(empty);
    expect(U(empty)).toEqual(unknown(1));
  });

  it("speakerKey is stable across utterances and signals", () => {
    const a = new SpeakerAttributor();
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [1000, 1500]);
    speakBetween(a, ADA, 3000, 4000);
    expect(U(a).speakerKey).toBe("participant:p-ada");
    expect(attribute(a, 3000, 4000, "S9").speakerKey).toBe("participant:p-ada");
  });
});

describe("Unknown speakers", () => {
  it("numbers from 1, the same label gets the same number", () => {
    const a = new SpeakerAttributor();
    expect(attribute(a, 0, 100, "S7")).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "S2")).toEqual(unknown(2));
    expect(attribute(a, 0, 100, "S7")).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "S2")).toEqual(unknown(2));
  });

  it("no-label shared slot gets its own number on first use", () => {
    const a = new SpeakerAttributor();
    expect(attribute(a, 0, 100, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "S1")).toEqual(unknown(2));
    expect(attribute(a, 0, 100, null)).toEqual(unknown(1));

    const fresh = new SpeakerAttributor();
    expect(attribute(fresh, 0, 100, "S1")).toEqual(unknown(1));
    expect(attribute(fresh, 0, 100, null)).toEqual(unknown(2));
    expect(attribute(fresh, 0, 100, null)).toEqual(unknown(2));
  });

  it("blank label uses the shared slot", () => {
    const a = new SpeakerAttributor();
    expect(attribute(a, 0, 100, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "")).toEqual(unknown(1));
    expect(attribute(a, 0, 100, "  ")).toEqual(unknown(1));
  });

  it("a number is allocated only when the speaker is unknown", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
    expect(attribute(a, 5000, 6000, "S2")).toEqual(unknown(1));
    expect(attribute(a, 7000, 8000, "S1")).toEqual(unknown(2));
  });

  it("no name is derived from a label or from history", () => {
    const a = new SpeakerAttributor();
    speakBetween(a, ADA, 1000, 2000);
    expect(U(a)).toEqual(named(ADA));
    expect(attribute(a, 5000, 6000, "S1")).toEqual(unknown(1));
  });
});

describe("Retention", () => {
  it("drops intervals older than retention", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 });
    speakBetween(a, ADA, 0, 1000);
    expect(attribute(a, 0, 1000, null)).toEqual(named(ADA));
    expect(attribute(a, 5000, 6000, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 1000, null)).toEqual(unknown(1));
  });

  it("the boundary is kept, one past it is dropped", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 });
    speakBetween(a, ADA, 0, 1000);
    expect(attribute(a, 1500, 2000, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 1000, null)).toEqual(named(ADA));
    expect(attribute(a, 1500, 2001, null)).toEqual(unknown(1));
    expect(attribute(a, 0, 1000, null)).toEqual(unknown(1));
  });

  it("source samples are dropped by the end of their hold", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 });
    identify(a, "csrc:1", ADA);
    activity(a, "csrc:1", [0, 500]);
    expect(attribute(a, 0, 1000, null)).toEqual(named(ADA));
    expect(attribute(a, 1900, 2000, null)).toEqual(unknown(1));
    expect(attribute(a, 500, 1000, null)).toEqual(named(ADA));
    expect(attribute(a, 0, 500, null)).toEqual(unknown(1));
  });

  it("an open interval is never dropped", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 });
    a.recordSpeaker({ atMs: 0, ...ADA, speaking: true });
    expect(attribute(a, 10000, 11000)).toEqual(named(ADA));
    expect(attribute(a, 500000, 501000)).toEqual(named(ADA));
  });

  it("identities, names and numbers survive pruning", () => {
    const a = new SpeakerAttributor({ retentionMs: 1000 });
    identify(a, "csrc:1", ADA);
    expect(attribute(a, 0, 1000, "S1")).toEqual(unknown(1));
    expect(attribute(a, 100000, 101000, "S2")).toEqual(unknown(2));
    activity(a, "csrc:1", [200000, 200500]);
    expect(attribute(a, 200000, 201000, "S1")).toEqual(named(ADA));
    expect(attribute(a, 300000, 301000, "S1")).toEqual(unknown(1));
  });
});
