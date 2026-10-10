// Salted hashing of participant and audio source ids for the meet-probe report.
// UNVERIFIED AGAINST THE REAL SERVICE: the format of Meet's `data-ssrc` value is not known yet.

import { createHash } from "node:crypto";

const MAX_SOURCE_ID_LENGTH = 256;
const NUMERIC_SOURCE_ID = /^[0-9]{1,10}$/;
const SOURCE_KEY = /^(csrc|ssrc):([0-9]{1,10})$/;

export type ProbeHashDomain = "pid" | "src";

export const PROBE_HASH_LENGTH = 16;
export const PROBE_HASH_PATTERN = /^[0-9a-f]{16}$/;
export const PROBE_SALT_PATTERN = /^[0-9a-f]{64}$/;

export function hashProbeValue(salt: string, domain: ProbeHashDomain, value: string): string {
  // An unsalted hash of a 32-bit SSRC could be enumerated, so a bad salt must stop the run.
  if (!PROBE_SALT_PATTERN.test(salt)) {
    throw new Error("The probe salt must be 64 lower-case hex characters; refusing to hash without it");
  }
  return createHash("sha256")
    .update(`${salt}|${domain}|${value}`, "utf8")
    .digest("hex")
    .slice(0, PROBE_HASH_LENGTH);
}

// The page and Node must agree on this form, otherwise a tile's data-ssrc never joins a receiver source.
export function canonicalSourceId(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (NUMERIC_SOURCE_ID.test(trimmed)) return String(Number(trimmed));
  return trimmed.slice(0, MAX_SOURCE_ID_LENGTH);
}

export function sourceIdOfKey(sourceKey: string): string | null {
  const capturedId = SOURCE_KEY.exec(sourceKey)?.[2];
  if (capturedId === undefined) return null;
  return canonicalSourceId(capturedId);
}

export function hashSourceKey(salt: string, sourceKey: string): string {
  const match = SOURCE_KEY.exec(sourceKey);
  const kind = match?.[1];
  const capturedId = match?.[2];
  if (kind === undefined || capturedId === undefined)
    return `other:${hashProbeValue(salt, "src", sourceKey)}`;
  const id = canonicalSourceId(capturedId);
  if (id === null) return `other:${hashProbeValue(salt, "src", sourceKey)}`;
  return `${kind}:${hashProbeValue(salt, "src", id)}`;
}
