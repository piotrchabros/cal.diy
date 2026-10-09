// UNVERIFIED AGAINST THE REAL SERVICE (attribution rules of T175): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/speaker-attribution-spike.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
import type { AttributionSignal, ISpeakerAttributor, SpeakerAttribution } from "./SpeakerAttribution";

type Interval = { startMs: number; endMs: number };
type UiTimeline = { closed: Interval[]; openSinceMs: number | null };
type AttributionRules = {
  signalOrder: AttributionSignal[];
  minOverlapRatio: number;
  maxRunnerUpRatio: number;
  sourceActivityHoldMs: number;
  minSourceLevel: number;
  retentionMs: number;
};

const PROVISIONAL_ATTRIBUTION_RULES: AttributionRules = {
  signalOrder: ["CONTRIBUTING_SOURCE", "UI_ACTIVE_SPEAKER"],
  minOverlapRatio: 0.6,
  maxRunnerUpRatio: 0.3,
  sourceActivityHoldMs: 500,
  minSourceLevel: 0.05,
  retentionMs: 120000,
};

// Length of the union of the intervals once clipped to the window, so overlapping evidence is never counted twice.
function coveredMs(intervals: Interval[], windowStartMs: number, windowEndMs: number): number {
  const clipped: Interval[] = [];
  for (const interval of intervals) {
    const startMs = Math.max(interval.startMs, windowStartMs);
    const endMs = Math.min(interval.endMs, windowEndMs);
    if (endMs > startMs) clipped.push({ startMs, endMs });
  }
  clipped.sort((a, b) => a.startMs - b.startMs);

  let total = 0;
  let currentStartMs = 0;
  let currentEndMs = 0;
  let hasCurrent = false;
  for (const interval of clipped) {
    if (hasCurrent && interval.startMs <= currentEndMs) {
      currentEndMs = Math.max(currentEndMs, interval.endMs);
      continue;
    }
    if (hasCurrent) total += currentEndMs - currentStartMs;
    currentStartMs = interval.startMs;
    currentEndMs = interval.endMs;
    hasCurrent = true;
  }
  if (hasCurrent) total += currentEndMs - currentStartMs;
  return total;
}

function addInterval(
  byParticipant: Map<string, Interval[]>,
  participantId: string,
  interval: Interval
): void {
  const list = byParticipant.get(participantId);
  if (list) {
    list.push(interval);
    return;
  }
  byParticipant.set(participantId, [interval]);
}

function buildUiIntervals(timelines: Map<string, UiTimeline>): Map<string, Interval[]> {
  const byParticipant = new Map<string, Interval[]>();
  for (const [participantId, timeline] of timelines) {
    for (const interval of timeline.closed) addInterval(byParticipant, participantId, interval);
    if (timeline.openSinceMs !== null) {
      addInterval(byParticipant, participantId, {
        startMs: timeline.openSinceMs,
        endMs: Number.POSITIVE_INFINITY,
      });
    }
  }
  return byParticipant;
}

function buildSourceIntervals(
  samples: Map<string, number[]>,
  sourceParticipants: Map<string, string>,
  holdMs: number
): Map<string, Interval[]> {
  const byParticipant = new Map<string, Interval[]>();
  for (const [sourceKey, atMsList] of samples) {
    const participantId = sourceParticipants.get(sourceKey);
    if (participantId === undefined) continue;
    for (const atMs of atMsList)
      addInterval(byParticipant, participantId, { startMs: atMs, endMs: atMs + holdMs });
  }
  return byParticipant;
}

// Returns the participant a signal names, or null when the signal is silent, conflicting or ambiguous.
function pickParticipant(
  byParticipant: Map<string, Interval[]>,
  window: { startMs: number; endMs: number },
  rules: AttributionRules,
  names: Map<string, string>
): string | null {
  const durationMs = window.endMs - window.startMs;
  let bestId: string | null = null;
  let bestMs = 0;
  let secondMs = 0;
  for (const [participantId, intervals] of byParticipant) {
    const covered = coveredMs(intervals, window.startMs, window.endMs);
    if (covered <= 0) continue;
    if (covered > bestMs) {
      secondMs = bestMs;
      bestMs = covered;
      bestId = participantId;
    } else if (covered > secondMs) {
      secondMs = covered;
    }
  }
  if (bestId === null) return null;
  if (bestMs / durationMs < rules.minOverlapRatio) return null;
  if (secondMs / durationMs > rules.maxRunnerUpRatio) return null;
  if (secondMs >= bestMs) return null;
  if (!names.has(bestId)) return null;
  return bestId;
}

class SpeakerAttributor implements ISpeakerAttributor {
  private readonly rules: AttributionRules;
  private readonly uiTimelines = new Map<string, UiTimeline>();
  private readonly sourceSamples = new Map<string, number[]>();
  private readonly sourceParticipants = new Map<string, string>();
  private readonly participantNames = new Map<string, string>();
  private readonly labelNumbers = new Map<string, number>();
  private noLabelNumber: number | null = null;
  private nextUnknownNumber = 1;
  private latestAttributedEndMs = Number.NEGATIVE_INFINITY;

  constructor(rules?: Partial<AttributionRules>) {
    this.rules = {
      signalOrder: [...(rules?.signalOrder ?? PROVISIONAL_ATTRIBUTION_RULES.signalOrder)],
      minOverlapRatio: rules?.minOverlapRatio ?? PROVISIONAL_ATTRIBUTION_RULES.minOverlapRatio,
      maxRunnerUpRatio: rules?.maxRunnerUpRatio ?? PROVISIONAL_ATTRIBUTION_RULES.maxRunnerUpRatio,
      sourceActivityHoldMs: rules?.sourceActivityHoldMs ?? PROVISIONAL_ATTRIBUTION_RULES.sourceActivityHoldMs,
      minSourceLevel: rules?.minSourceLevel ?? PROVISIONAL_ATTRIBUTION_RULES.minSourceLevel,
      retentionMs: rules?.retentionMs ?? PROVISIONAL_ATTRIBUTION_RULES.retentionMs,
    };
  }

  recordSpeaker(sample: { atMs: number; participantId: string; name: string; speaking: boolean }): void {
    if (!Number.isFinite(sample.atMs) || sample.participantId === "") return;
    this.rememberName(sample.participantId, sample.name);

    let timeline = this.uiTimelines.get(sample.participantId);
    if (!timeline) {
      timeline = { closed: [], openSinceMs: null };
      this.uiTimelines.set(sample.participantId, timeline);
    }
    if (sample.speaking) {
      if (timeline.openSinceMs === null) timeline.openSinceMs = sample.atMs;
      return;
    }
    if (timeline.openSinceMs === null) return;
    if (sample.atMs > timeline.openSinceMs) {
      timeline.closed.push({ startMs: timeline.openSinceMs, endMs: sample.atMs });
    }
    timeline.openSinceMs = null;
  }

  recordSourceActivity(sample: { atMs: number; sourceKey: string; level: number }): void {
    if (!Number.isFinite(sample.atMs) || sample.sourceKey === "") return;
    if (!(sample.level >= this.rules.minSourceLevel)) return;
    const list = this.sourceSamples.get(sample.sourceKey);
    if (list) {
      list.push(sample.atMs);
      return;
    }
    this.sourceSamples.set(sample.sourceKey, [sample.atMs]);
  }

  recordSourceIdentity(identity: { sourceKey: string; participantId: string; name: string }): void {
    if (identity.sourceKey === "" || identity.participantId === "") return;
    this.sourceParticipants.set(identity.sourceKey, identity.participantId);
    this.rememberName(identity.participantId, identity.name);
  }

  attribute(utterance: {
    startMs: number;
    endMs: number;
    diarizationLabel: string | null;
  }): SpeakerAttribution {
    const startMs = utterance.startMs;
    const endMs = Math.max(utterance.startMs, utterance.endMs);
    const window = { startMs, endMs: Math.max(endMs, startMs + 1) };

    const result = this.attributeToParticipant(window) ?? this.attributeToUnknown(utterance.diarizationLabel);
    this.prune(endMs);
    return result;
  }

  private rememberName(participantId: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed !== "") this.participantNames.set(participantId, trimmed);
  }

  private attributeToParticipant(window: { startMs: number; endMs: number }): SpeakerAttribution | null {
    for (const signal of this.rules.signalOrder) {
      const byParticipant = this.buildIntervals(signal);
      const participantId = pickParticipant(byParticipant, window, this.rules, this.participantNames);
      if (participantId === null) continue;
      const speakerName = this.participantNames.get(participantId);
      if (speakerName === undefined) continue;
      return { speakerKey: `participant:${participantId}`, speakerName, unknownSpeakerNumber: null };
    }
    return null;
  }

  private buildIntervals(signal: AttributionSignal): Map<string, Interval[]> {
    if (signal === "UI_ACTIVE_SPEAKER") return buildUiIntervals(this.uiTimelines);
    return buildSourceIntervals(this.sourceSamples, this.sourceParticipants, this.rules.sourceActivityHoldMs);
  }

  private attributeToUnknown(diarizationLabel: string | null): SpeakerAttribution {
    let number: number;
    if (diarizationLabel === null || diarizationLabel.trim() === "") {
      if (this.noLabelNumber === null) this.noLabelNumber = this.nextUnknownNumber++;
      number = this.noLabelNumber;
    } else {
      const existing = this.labelNumbers.get(diarizationLabel);
      if (existing === undefined) {
        number = this.nextUnknownNumber++;
        this.labelNumbers.set(diarizationLabel, number);
      } else {
        number = existing;
      }
    }
    return { speakerKey: `unknown:${number}`, speakerName: null, unknownSpeakerNumber: number };
  }

  // Open intervals, source mappings, names and unknown numbers are kept: they are small and dropping them
  // would change who an utterance is attributed to.
  private prune(endMs: number): void {
    this.latestAttributedEndMs = Math.max(this.latestAttributedEndMs, endMs);
    const horizonMs = this.latestAttributedEndMs - this.rules.retentionMs;

    for (const timeline of this.uiTimelines.values()) {
      timeline.closed = timeline.closed.filter((interval) => interval.endMs >= horizonMs);
    }
    for (const [sourceKey, atMsList] of this.sourceSamples) {
      const kept = atMsList.filter((atMs) => atMs + this.rules.sourceActivityHoldMs >= horizonMs);
      if (kept.length === 0) this.sourceSamples.delete(sourceKey);
      else this.sourceSamples.set(sourceKey, kept);
    }
  }
}

export type { AttributionRules };
export { PROVISIONAL_ATTRIBUTION_RULES, SpeakerAttributor };
