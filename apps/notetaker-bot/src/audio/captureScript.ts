// UNVERIFIED AGAINST THE REAL SERVICE (Chrome WebRTC and WebAudio): written from documentation and memory and
// exercised only against fakes. Run the manual check in docs/smoke-test-google-meet.md and record the result in
// docs/verification-status.md before relying on it, then remove this notice.
// Run scripts/capture-smoke.ts first: it is the only check of this file against a real Chrome.
import { Buffer } from "node:buffer";
import type { Pcm16Frame } from "./AudioFrame";

// The page is untrusted, so anything it sends through a binding is bounded before it is decoded.
const MAX_FRAME_PAYLOAD_CHARS = 262144;
const MAX_ACTIVITY_ENTRIES = 64;
const SOURCE_KEY_PATTERN = /^(?:csrc|ssrc):\d+$/;

export const AUDIO_FRAME_BINDING = "__notetakerAudioFrame";
export const SOURCE_ACTIVITY_BINDING = "__notetakerSourceActivity";

export type AudioCaptureOptions = {
  frameBinding: string;
  activityBinding: string;
  sampleRate: number;
  bufferSamples: number;
  activityIntervalMs: number;
};

export const DEFAULT_AUDIO_CAPTURE_OPTIONS: AudioCaptureOptions = {
  frameBinding: AUDIO_FRAME_BINDING,
  activityBinding: SOURCE_ACTIVITY_BINDING,
  sampleRate: 16000,
  bufferSamples: 2048,
  activityIntervalMs: 250,
};

// Serialised with toString() and run inside the meeting page, so it must reference only its parameter, its own
// locals and page globals.
export function installAudioCapture(options: AudioCaptureOptions): void {
  const NativePeerConnection = globalThis.RTCPeerConnection;
  if (typeof NativePeerConnection !== "function") return;
  const taps = new Map<string, { receiver: RTCRtpReceiver; source: MediaStreamAudioSourceNode }>();
  let graph: { context: AudioContext; mixer: GainNode } | null = null;
  const call = (name: string, payload: unknown): void => {
    const binding: unknown = Reflect.get(globalThis, name);
    if (typeof binding === "function") binding(payload);
  };
  const ensureGraph = (): { context: AudioContext; mixer: GainNode } => {
    if (graph) return graph;
    const context = new AudioContext({ sampleRate: options.sampleRate });
    const mixer = context.createGain();
    const processor = context.createScriptProcessor(options.bufferSamples, 1, 1);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      let binary = "";
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
        const value = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
        binary += String.fromCharCode(value & 0xff, (value >> 8) & 0xff);
      }
      call(options.frameBinding, btoa(binary));
    };
    mixer.connect(processor);
    // Chrome only fires onaudioprocess for a processor that reaches the destination; its output is never written.
    processor.connect(context.destination);
    if (context.state === "suspended") Promise.resolve(context.resume()).catch(() => undefined);
    graph = { context, mixer };
    return graph;
  };
  const onTrack = (event: RTCTrackEvent): void => {
    const track = event.track;
    if (track.kind !== "audio" || taps.has(track.id)) return;
    const { context, mixer } = ensureGraph();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    source.connect(mixer);
    taps.set(track.id, { receiver: event.receiver, source });
    track.addEventListener("ended", () => {
      source.disconnect();
      taps.delete(track.id);
    });
  };
  // addEventListener rather than ontrack, which the page overwrites.
  globalThis.RTCPeerConnection = new Proxy(NativePeerConnection, {
    construct(target, args, newTarget) {
      const connection: RTCPeerConnection = Reflect.construct(target, args, newTarget);
      connection.addEventListener("track", onTrack);
      return connection;
    },
  });
  setInterval(() => {
    const cutoff = Date.now() - options.activityIntervalMs;
    const levels = new Map<string, number>();
    for (const tap of taps.values()) {
      const groups: [string, RTCRtpContributingSource[]][] = [
        ["csrc", tap.receiver.getContributingSources()],
        ["ssrc", tap.receiver.getSynchronizationSources()],
      ];
      for (const [prefix, entries] of groups) {
        for (const entry of entries) {
          if (entry.timestamp < cutoff || typeof entry.audioLevel !== "number") continue;
          const key = `${prefix}:${entry.source}`;
          levels.set(key, Math.max(levels.get(key) ?? 0, entry.audioLevel));
        }
      }
    }
    if (levels.size === 0) return;
    call(
      options.activityBinding,
      Array.from(levels, ([sourceKey, level]) => ({ sourceKey, level }))
    );
  }, options.activityIntervalMs);
}

export function buildAudioCaptureInitScript(
  options: AudioCaptureOptions = DEFAULT_AUDIO_CAPTURE_OPTIONS
): string {
  // tsx and esbuild keep-names inject a __name helper into stringified functions; the page has no such helper.
  return `(() => { const __name = (target) => target; (${installAudioCapture.toString()})(${JSON.stringify(options)}); })();`;
}

export function decodeAudioFramePayload(payload: unknown): Pcm16Frame | null {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_FRAME_PAYLOAD_CHARS) {
    return null;
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) return null;
  if (bytes.length % 2 !== 0) return null;
  // Read through readInt16LE: a pooled Buffer can sit at an odd offset, which a typed-array view would reject.
  const samples = new Int16Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2);
  return { samples };
}

export function decodeSourceActivityPayload(payload: unknown): { sourceKey: string; level: number }[] | null {
  if (!Array.isArray(payload) || payload.length > MAX_ACTIVITY_ENTRIES) return null;
  const result: { sourceKey: string; level: number }[] = [];
  for (const entry of payload as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const sourceKey: unknown = Reflect.get(entry, "sourceKey");
    const level: unknown = Reflect.get(entry, "level");
    if (typeof sourceKey !== "string" || !SOURCE_KEY_PATTERN.test(sourceKey)) return null;
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) return null;
    result.push({ sourceKey, level });
  }
  return result;
}
