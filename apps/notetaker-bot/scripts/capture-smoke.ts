// UNVERIFIED AGAINST THE REAL SERVICE (Chrome WebRTC and WebAudio; this script was not run by its authors): written
// from documentation and memory. It is itself the manual check of src/audio/captureScript.ts: run it, record
// the result in docs/verification-status.md, then remove this notice.
//
// Usage: yarn workspace @calcom/notetaker-bot tsx scripts/capture-smoke.ts
// Needs a Chromium for Playwright 1.57, or NOTETAKER_CHROME_CHANNEL=chrome to use an installed Chrome.
// It keeps no audio and writes no file.
import process from "node:process";
import { chromium } from "playwright";
import { AUDIO_SAMPLE_RATE_HZ } from "../src/audio/AudioFrame";
import {
  AUDIO_FRAME_BINDING,
  buildAudioCaptureInitScript,
  decodeAudioFramePayload,
  decodeSourceActivityPayload,
  SOURCE_ACTIVITY_BINDING,
} from "../src/audio/captureScript";

const WINDOW_MS = 5000;
const SMOKE_URL = "https://capture-smoke.invalid/";

type SmokeCounters = {
  frames: number;
  samples: number;
  nonSilentFrames: number;
  rejectedPayloads: number;
  activityCalls: number;
  activitySources: number;
};

// Runs inside the page, so it must not reference anything outside its own body. Promise chains instead of
// async/await keep the serialised source free of helpers the transpiler would inject.
function startLoopback(): Promise<void> {
  const connectTimeoutMs = 10000;
  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  oscillator.frequency.value = 440;
  const destination = audioContext.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();

  const sender = new RTCPeerConnection();
  const receiver = new RTCPeerConnection();
  sender.addEventListener("icecandidate", (event) => {
    if (event.candidate) receiver.addIceCandidate(event.candidate).catch(() => undefined);
  });
  receiver.addEventListener("icecandidate", (event) => {
    if (event.candidate) sender.addIceCandidate(event.candidate).catch(() => undefined);
  });

  // A meeting page plays remote audio through a media element; the capture hook is expected to see it there.
  const audioElement = new Audio();
  receiver.addEventListener("track", (event) => {
    audioElement.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    audioElement.play().catch(() => undefined);
  });

  Reflect.set(globalThis, "__captureSmoke", {
    audioContext,
    oscillator,
    destination,
    sender,
    receiver,
    audioElement,
  });

  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Loopback peer connection did not connect within 10 s"));
    }, connectTimeoutMs);
    const checkConnected = () => {
      const ice = receiver.iceConnectionState;
      if (receiver.connectionState === "connected" || ice === "connected" || ice === "completed") {
        clearTimeout(timer);
        resolve();
      }
    };
    receiver.addEventListener("connectionstatechange", checkConnected);
    receiver.addEventListener("iceconnectionstatechange", checkConnected);
  });

  for (const track of destination.stream.getAudioTracks()) {
    sender.addTrack(track, destination.stream);
  }

  return sender
    .createOffer()
    .then((offer) => sender.setLocalDescription(offer).then(() => receiver.setRemoteDescription(offer)))
    .then(() => receiver.createAnswer())
    .then((answer) => receiver.setLocalDescription(answer).then(() => sender.setRemoteDescription(answer)))
    .then(() => connected);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<number> {
  const counters: SmokeCounters = {
    frames: 0,
    samples: 0,
    nonSilentFrames: 0,
    rejectedPayloads: 0,
    activityCalls: 0,
    activitySources: 0,
  };

  const browser = await chromium.launch({
    headless: true,
    channel: process.env.NOTETAKER_CHROME_CHANNEL || undefined,
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.exposeBinding(AUDIO_FRAME_BINDING, (_source, payload: unknown) => {
      const frame = decodeAudioFramePayload(payload);
      if (!frame) {
        counters.rejectedPayloads += 1;
        return;
      }
      counters.frames += 1;
      counters.samples += frame.samples.length;
      if (frame.samples.some((sample) => sample !== 0)) counters.nonSilentFrames += 1;
    });
    await page.exposeBinding(SOURCE_ACTIVITY_BINDING, (_source, payload: unknown) => {
      const sources = decodeSourceActivityPayload(payload);
      if (!sources) {
        counters.rejectedPayloads += 1;
        return;
      }
      counters.activityCalls += 1;
      counters.activitySources += sources.length;
    });

    await page.addInitScript(buildAudioCaptureInitScript());

    // A real navigation in a secure origin, without any network, so the init script runs on a fresh document.
    await page.route(SMOKE_URL, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>capture smoke</title>" })
    );
    await page.goto(SMOKE_URL);

    // tsx injects __name calls into serialised functions; the page has no such helper.
    await page.evaluate(
      `(() => { const __name = (target) => target; return (${startLoopback.toString()})(); })()`
    );

    await delay(WINDOW_MS);
  } finally {
    await browser.close();
  }

  console.log(
    `capture-smoke: frames=${counters.frames} audioMs=${Math.round(
      (counters.samples * 1000) / AUDIO_SAMPLE_RATE_HZ
    )} nonSilentFrames=${counters.nonSilentFrames} rejectedPayloads=${counters.rejectedPayloads} activityCalls=${
      counters.activityCalls
    } activitySources=${counters.activitySources} windowMs=${WINDOW_MS}`
  );

  // A connected processor fires with zeros even when no remote audio flows, so frames alone prove nothing.
  if (counters.frames === 0) {
    console.error("capture-smoke: FAIL, frames is 0 (no audio frame reached the binding)");
    return 1;
  }
  if (counters.nonSilentFrames === 0) {
    console.error("capture-smoke: FAIL, nonSilentFrames is 0 (frames arrived but all were silent)");
    return 1;
  }
  return 0;
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`capture-smoke: error: ${message}`);
    console.error("Hint: install Chromium for Playwright, or set NOTETAKER_CHROME_CHANNEL=chrome.");
    return 1;
  })
  .then((code) => {
    process.exitCode = code;
  });
