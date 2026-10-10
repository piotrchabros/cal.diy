// UNVERIFIED AGAINST THE REAL SERVICE (attribution rules of T175): the indicator tokens and the source timestamps
// these rules rely on were measured on 2026-10-10, but the rules themselves were exercised only against fakes.
// Run the manual check in docs/speaker-attribution-spike.md and record the result in docs/verification-status.md
// before relying on it, then remove this notice.
import { createHash, randomBytes } from "node:crypto";
import type {
  AttributionSignal,
  ISpeakerAttributor,
  ParticipantSample,
  SpeakerAttribution,
  SpeakerResolution,
} from "./SpeakerAttribution";

type Interval = { startMs: number; endMs: number };
type PendingWindow = { startMs: number; endMs: number; label: string };
type ParticipantsReading = { atMs: number; speakingNowIds: string[] };
type UiTimeline = { closed: Interval[]; openSinceMs: number | null };
type AttributionRules = {
  signalOrder: AttributionSignal[];
  minOverlapRatio: number;
  maxRunnerUpRatio: number;
  sourceActivityHoldMs: number;
  minSourceLevel: number;
  retentionMs: number;
  minVoiceVotes: number;
  minVoiceAgreement: number;
  minLinkVotes: number;
  minLinkShare: number;
  maxIndicatorAgeMs: number;
  learnableSourcePrefix: string;
};

const PROVISIONAL_ATTRIBUTION_RULES: AttributionRules = {
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
};

const MAX_SPEAKER_NAME_LENGTH = 200;
const MAX_PENDING_WINDOWS = 500;
const SPEAKER_KEY_HASH_LENGTH = 16;

// The meeting's own participant id never leaves the bot: the key is a salted hash, so keys of two sessions
// cannot be joined.
function participantSpeakerKey(salt: string, participantId: string): string {
  const digest = createHash("sha256").update(`${salt}:${participantId}`).digest("hex");
  return `participant:${digest.slice(0, SPEAKER_KEY_HASH_LENGTH)}`;
}

function normaliseName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function cutName(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  let cut = name.slice(0, maxLength);
  const last = cut.charCodeAt(cut.length - 1);
  // A cut between the two halves of a surrogate pair would leave an invalid character at the end.
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

function increment(counts: Map<string, Map<string, number>>, outerKey: string, innerKey: string): void {
  let inner = counts.get(outerKey);
  if (!inner) {
    inner = new Map<string, number>();
    counts.set(outerKey, inner);
  }
  inner.set(innerKey, (inner.get(innerKey) ?? 0) + 1);
}

function sameLinks(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [sourceKey, participantId] of a) {
    if (b.get(sourceKey) !== participantId) return false;
  }
  return true;
}

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
  private readonly salt: string;
  private readonly uiTimelines = new Map<string, UiTimeline>();
  private readonly sourceSamples = new Map<string, number[]>();
  private readonly sourceParticipants = new Map<string, string>();
  private readonly participantNames = new Map<string, string>();
  private readonly nameRegistry = new Map<string, string[]>();
  private readonly speakerKeys = new Map<string, string>();
  private readonly selfIds = new Set<string>();
  private readonly labelNumbers = new Map<string, number>();
  private readonly votes = new Map<string, Map<string, number>>();
  private readonly voiceTally = new Map<string, Map<string, number>>();
  private latestReading: ParticipantsReading | null = null;
  private links = new Map<string, string>();
  private linksStale = false;
  private pendingStale = false;
  private pending: PendingWindow[] = [];
  private anyNamed = false;
  private noLabelNumber: number | null = null;
  private nextUnknownNumber = 1;
  private latestAttributedEndMs = Number.NEGATIVE_INFINITY;

  constructor(rules?: Partial<AttributionRules>, options?: { salt?: string }) {
    this.rules = {
      signalOrder: [...(rules?.signalOrder ?? PROVISIONAL_ATTRIBUTION_RULES.signalOrder)],
      minOverlapRatio: rules?.minOverlapRatio ?? PROVISIONAL_ATTRIBUTION_RULES.minOverlapRatio,
      maxRunnerUpRatio: rules?.maxRunnerUpRatio ?? PROVISIONAL_ATTRIBUTION_RULES.maxRunnerUpRatio,
      sourceActivityHoldMs: rules?.sourceActivityHoldMs ?? PROVISIONAL_ATTRIBUTION_RULES.sourceActivityHoldMs,
      minSourceLevel: rules?.minSourceLevel ?? PROVISIONAL_ATTRIBUTION_RULES.minSourceLevel,
      retentionMs: rules?.retentionMs ?? PROVISIONAL_ATTRIBUTION_RULES.retentionMs,
      minVoiceVotes: rules?.minVoiceVotes ?? PROVISIONAL_ATTRIBUTION_RULES.minVoiceVotes,
      minVoiceAgreement: rules?.minVoiceAgreement ?? PROVISIONAL_ATTRIBUTION_RULES.minVoiceAgreement,
      minLinkVotes: rules?.minLinkVotes ?? PROVISIONAL_ATTRIBUTION_RULES.minLinkVotes,
      minLinkShare: rules?.minLinkShare ?? PROVISIONAL_ATTRIBUTION_RULES.minLinkShare,
      maxIndicatorAgeMs: rules?.maxIndicatorAgeMs ?? PROVISIONAL_ATTRIBUTION_RULES.maxIndicatorAgeMs,
      learnableSourcePrefix:
        rules?.learnableSourcePrefix ?? PROVISIONAL_ATTRIBUTION_RULES.learnableSourcePrefix,
    };
    this.salt = options?.salt ?? randomBytes(16).toString("hex");
  }

  recordSpeaker(sample: { atMs: number; participantId: string; name: string; speaking: boolean }): void {
    if (!Number.isFinite(sample.atMs) || sample.participantId === "") return;
    if (this.selfIds.has(sample.participantId)) return;
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

  recordParticipants(sample: { atMs: number; participants: ParticipantSample[] }): void {
    if (!Number.isFinite(sample.atMs)) return;
    const speakingNowIds = new Set<string>();
    for (const participant of sample.participants) {
      const participantId = participant.participantId;
      if (participantId === "") continue;
      if (participant.isSelf && !this.selfIds.has(participantId)) {
        this.selfIds.add(participantId);
        // Votes cast for this id before it was known to be the bot must stop counting.
        this.linksStale = true;
      }
      if (this.selfIds.has(participantId)) continue;
      this.rememberName(participantId, participant.name);
      if (participant.speakingNow) speakingNowIds.add(participantId);
    }
    this.latestReading = { atMs: sample.atMs, speakingNowIds: [...speakingNowIds] };
  }

  recordSourceActivity(sample: { atMs: number; sourceKey: string; level: number }): void {
    if (!Number.isFinite(sample.atMs) || sample.sourceKey === "") return;
    if (!(sample.level >= this.rules.minSourceLevel)) return;
    this.castLinkVote(sample.atMs, sample.sourceKey);
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
    const label =
      utterance.diarizationLabel === null || utterance.diarizationLabel.trim() === ""
        ? null
        : utterance.diarizationLabel;

    this.latestAttributedEndMs = Math.max(this.latestAttributedEndMs, endMs);
    this.dropExpiredPending();
    this.reevaluatePending();

    const result = this.attributeWindow(window, label);
    if (result.speakerName !== null) this.anyNamed = true;
    this.prune();
    return result;
  }

  resolutions(): SpeakerResolution[] {
    this.reevaluatePending();
    const numbered = [...this.labelNumbers].sort((a, b) => a[1] - b[1]);
    const resolved: SpeakerResolution[] = [];
    for (const [label, number] of numbered) {
      const participantId = this.voiceParticipant(label);
      if (participantId === null) continue;
      const named = this.named(participantId);
      if (named === null || named.speakerName === null) continue;
      resolved.push({
        speakerKey: `unknown:${number}`,
        resolvedSpeakerKey: named.speakerKey,
        speakerName: named.speakerName,
      });
    }
    return resolved;
  }

  namesAvailable(): boolean {
    return this.anyNamed || this.resolutions().length > 0;
  }

  learnedLinks(): ReadonlyMap<string, string> {
    this.refreshLinks();
    return new Map(this.links);
  }

  private rememberName(participantId: string, name: string): void {
    if (this.selfIds.has(participantId)) return;
    const normalised = normaliseName(name);
    if (normalised === "") return;
    this.participantNames.set(participantId, normalised);
    const sharing = this.nameRegistry.get(normalised);
    if (!sharing) {
      this.nameRegistry.set(normalised, [participantId]);
      return;
    }
    if (!sharing.includes(participantId)) sharing.push(participantId);
  }

  // The list of a name is append-only, so the number a participant got never changes while it keeps the name.
  private displayName(participantId: string): string | null {
    const name = this.participantNames.get(participantId);
    if (name === undefined) return null;
    const index = this.nameRegistry.get(name)?.indexOf(participantId) ?? 0;
    const suffix = index >= 1 ? ` (${index + 1})` : "";
    return `${cutName(name, MAX_SPEAKER_NAME_LENGTH - suffix.length)}${suffix}`;
  }

  private named(participantId: string): SpeakerAttribution | null {
    const speakerName = this.displayName(participantId);
    if (speakerName === null) return null;
    let speakerKey = this.speakerKeys.get(participantId);
    if (speakerKey === undefined) {
      speakerKey = participantSpeakerKey(this.salt, participantId);
      this.speakerKeys.set(participantId, speakerKey);
    }
    return { speakerKey, speakerName, unknownSpeakerNumber: null };
  }

  // The instantaneous indicator has no trailing hold, so a source heard while exactly one tile shows it is
  // evidence for that participant. A reading that is stale or marks several people proves nothing.
  private castLinkVote(atMs: number, sourceKey: string): void {
    if (!sourceKey.startsWith(this.rules.learnableSourcePrefix)) return;
    const reading = this.latestReading;
    if (reading === null) return;
    const ageMs = atMs - reading.atMs;
    if (!(ageMs >= 0 && ageMs <= this.rules.maxIndicatorAgeMs)) return;
    if (reading.speakingNowIds.length !== 1) return;
    const participantId = reading.speakingNowIds[0];
    if (participantId === undefined) return;
    increment(this.votes, sourceKey, participantId);
    this.linksStale = true;
  }

  // Never latched: a link exists only while the votes support it. The share is normalised by how much each
  // participant talked, otherwise a source heard with everybody would link to whoever talked most.
  private computeLinks(): Map<string, string> {
    const talk = new Map<string, number>();
    for (const byParticipant of this.votes.values()) {
      for (const [participantId, count] of byParticipant) {
        if (this.selfIds.has(participantId)) continue;
        if (count > (talk.get(participantId) ?? 0)) talk.set(participantId, count);
      }
    }
    const established: [string, number][] = [];
    for (const [participantId, count] of talk) {
      if (count >= this.rules.minLinkVotes) established.push([participantId, count]);
    }

    const links = new Map<string, string>();
    // With one established participant a source of their own cannot be told from a source heard with everybody.
    if (established.length < 2) return links;

    for (const [sourceKey, byParticipant] of this.votes) {
      let presenceSum = 0;
      let bestId: string | null = null;
      let bestPresence = 0;
      let isTied = false;
      for (const [participantId, talkVotes] of established) {
        const presence = (byParticipant.get(participantId) ?? 0) / talkVotes;
        presenceSum += presence;
        if (presence > bestPresence) {
          bestPresence = presence;
          bestId = participantId;
          isTied = false;
        } else if (presence > 0 && presence === bestPresence) {
          isTied = true;
        }
      }
      if (bestId === null || isTied) continue;
      if ((byParticipant.get(bestId) ?? 0) < this.rules.minLinkVotes) continue;
      if (bestPresence / presenceSum < this.rules.minLinkShare) continue;
      links.set(sourceKey, bestId);
    }
    return links;
  }

  private refreshLinks(): void {
    if (!this.linksStale) return;
    this.linksStale = false;
    const links = this.computeLinks();
    if (sameLinks(links, this.links)) return;
    this.links = links;
    this.pendingStale = true;
  }

  private attributeWindow(window: Interval, label: string | null): SpeakerAttribution {
    const signalled = this.pickBySignals(window);
    if (signalled !== null) {
      const named = this.named(signalled);
      if (named !== null) {
        if (label !== null) increment(this.voiceTally, label, signalled);
        return named;
      }
    }
    if (label !== null) {
      const remembered = this.voiceParticipant(label);
      const named = remembered === null ? null : this.named(remembered);
      if (named !== null) return named;
      this.pending.push({ startMs: window.startMs, endMs: window.endMs, label });
      if (this.pending.length > MAX_PENDING_WINDOWS) this.pending.shift();
    }
    return this.attributeToUnknown(label);
  }

  private pickBySignals(window: Interval): string | null {
    for (const signal of this.rules.signalOrder) {
      const byParticipant = this.buildIntervals(signal);
      for (const selfId of this.selfIds) byParticipant.delete(selfId);
      const participantId = pickParticipant(byParticipant, window, this.rules, this.participantNames);
      if (participantId !== null) return participantId;
    }
    return null;
  }

  private buildIntervals(signal: AttributionSignal): Map<string, Interval[]> {
    if (signal === "UI_ACTIVE_SPEAKER") return buildUiIntervals(this.uiTimelines);
    this.refreshLinks();
    const sourceParticipants = new Map([...this.links, ...this.sourceParticipants]);
    return buildSourceIntervals(this.sourceSamples, sourceParticipants, this.rules.sourceActivityHoldMs);
  }

  // The participant a diarization label was confidently attributed to so far, or null while the evidence is
  // thin or split.
  private voiceParticipant(label: string): string | null {
    const tally = this.voiceTally.get(label);
    if (!tally) return null;
    let total = 0;
    let topId: string | null = null;
    let topCount = 0;
    let isTied = false;
    for (const [participantId, count] of tally) {
      total += count;
      if (count > topCount) {
        topCount = count;
        topId = participantId;
        isTied = false;
      } else if (count === topCount) {
        isTied = true;
      }
    }
    if (topId === null || isTied) return null;
    if (total < this.rules.minVoiceVotes) return null;
    if (topCount / total < this.rules.minVoiceAgreement) return null;
    if (this.selfIds.has(topId)) return null;
    return topId;
  }

  // Passages that were unknown only because a link was not learned yet still tell whose voice a label is.
  private reevaluatePending(): void {
    this.refreshLinks();
    if (!this.pendingStale) return;
    this.pendingStale = false;
    const stillPending: PendingWindow[] = [];
    for (const window of this.pending) {
      const participantId = this.pickBySignals(window);
      if (participantId === null) {
        stillPending.push(window);
        continue;
      }
      increment(this.voiceTally, window.label, participantId);
    }
    this.pending = stillPending;
  }

  private dropExpiredPending(): void {
    const horizonMs = this.latestAttributedEndMs - this.rules.retentionMs;
    this.pending = this.pending.filter((window) => window.endMs >= horizonMs);
  }

  private attributeToUnknown(label: string | null): SpeakerAttribution {
    let number: number;
    if (label === null) {
      if (this.noLabelNumber === null) this.noLabelNumber = this.nextUnknownNumber++;
      number = this.noLabelNumber;
    } else {
      const existing = this.labelNumbers.get(label);
      if (existing === undefined) {
        number = this.nextUnknownNumber++;
        this.labelNumbers.set(label, number);
      } else {
        number = existing;
      }
    }
    return { speakerKey: `unknown:${number}`, speakerName: null, unknownSpeakerNumber: number };
  }

  // Open intervals, source mappings, votes, names and unknown numbers are kept: they are small and dropping them
  // would change who an utterance is attributed to.
  private prune(): void {
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
export { PROVISIONAL_ATTRIBUTION_RULES, participantSpeakerKey, SpeakerAttributor };
