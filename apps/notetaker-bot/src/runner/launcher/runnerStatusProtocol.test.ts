// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildJoinRequest } from "../../testing/httpTestKit";
import type { RunnerStatus } from "./MeetingRunnerLauncher";
import {
  decodeJoinRequestEnv,
  encodeJoinRequestEnv,
  encodeRunnerStatus,
  findLastRunnerStatus,
  parseRunnerStatusLine,
  RUNNER_STATUS_PREFIX,
} from "./runnerStatusProtocol";

const PHASES: RunnerStatus["phase"][] = ["STARTING", "IN_MEETING", "WAITING", "ENDED"];

const toBase64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

describe("encodeRunnerStatus", () => {
  it("encodes a status as the prefix followed by JSON", () => {
    const line = encodeRunnerStatus({ phase: "IN_MEETING", lastEventSequence: 7 });

    expect(line).toBe('@@notetaker-status {"phase":"IN_MEETING","lastEventSequence":7}');
    expect(line).not.toContain("\n");
  });
});

describe("parseRunnerStatusLine", () => {
  it("round-trips every phase", () => {
    for (const phase of PHASES) {
      for (const lastEventSequence of [0, 12]) {
        const status: RunnerStatus = { phase, lastEventSequence };
        expect(parseRunnerStatusLine(encodeRunnerStatus(status))).toEqual(status);
      }
    }
  });

  it("parses a line with a trailing carriage return", () => {
    const status: RunnerStatus = { phase: "WAITING", lastEventSequence: 3 };

    expect(parseRunnerStatusLine(`${encodeRunnerStatus(status)}\r`)).toEqual(status);
  });

  it("parses a line with leading noise", () => {
    const status: RunnerStatus = { phase: "IN_MEETING", lastEventSequence: 5 };
    const line = encodeRunnerStatus(status);

    expect(parseRunnerStatusLine(`\u0001\u0000\u0000\u0000\u0000\u0000\u0000B${line}`)).toEqual(status);
    expect(parseRunnerStatusLine(`2030-01-01T10:00:00Z ${line}`)).toEqual(status);
  });

  it("uses the last prefix when a line holds two", () => {
    const first = encodeRunnerStatus({ phase: "STARTING", lastEventSequence: 1 });
    const second = encodeRunnerStatus({ phase: "ENDED", lastEventSequence: 9 });

    expect(parseRunnerStatusLine(`${first}${second}`)).toEqual({ phase: "ENDED", lastEventSequence: 9 });
  });

  it("returns null without the prefix", () => {
    expect(parseRunnerStatusLine("just a plain log line")).toBeNull();
    expect(parseRunnerStatusLine("")).toBeNull();
  });

  it("returns null for malformed JSON or trailing text", () => {
    expect(parseRunnerStatusLine(`${RUNNER_STATUS_PREFIX}{`)).toBeNull();
    expect(
      parseRunnerStatusLine(`${RUNNER_STATUS_PREFIX}{"phase":"IN_MEETING","lastEventSequence":7} extra`)
    ).toBeNull();
  });

  it("returns null for an unknown phase", () => {
    expect(
      parseRunnerStatusLine(`${RUNNER_STATUS_PREFIX}{"phase":"PAUSED","lastEventSequence":7}`)
    ).toBeNull();
  });

  it("returns null for a bad sequence", () => {
    const bodies = [
      '{"phase":"IN_MEETING","lastEventSequence":-1}',
      '{"phase":"IN_MEETING","lastEventSequence":1.5}',
      '{"phase":"IN_MEETING","lastEventSequence":"7"}',
      '{"phase":"IN_MEETING"}',
    ];

    for (const body of bodies) {
      expect(parseRunnerStatusLine(`${RUNNER_STATUS_PREFIX}${body}`)).toBeNull();
    }
  });

  it("drops unknown keys", () => {
    const parsed = parseRunnerStatusLine(
      `${RUNNER_STATUS_PREFIX}{"phase":"IN_MEETING","lastEventSequence":7,"extra":"value"}`
    );

    expect(parsed).toEqual({ phase: "IN_MEETING", lastEventSequence: 7 });
  });
});

describe("findLastRunnerStatus", () => {
  const first = encodeRunnerStatus({ phase: "STARTING", lastEventSequence: 1 });
  const second = encodeRunnerStatus({ phase: "IN_MEETING", lastEventSequence: 4 });

  it("finds the last status in multi-line text", () => {
    const expected = { phase: "IN_MEETING", lastEventSequence: 4 };

    expect(findLastRunnerStatus(`noise\n${first}\nmore noise\n${second}\ntrailing noise\n`)).toEqual(
      expected
    );
    expect(
      findLastRunnerStatus(`noise\r\n${first}\r\nmore noise\r\n${second}\r\ntrailing noise\r\n`)
    ).toEqual(expected);
  });

  it("skips a truncated last line", () => {
    const text = `${first}\n${RUNNER_STATUS_PREFIX}{"phase":"IN_M`;

    expect(findLastRunnerStatus(text)).toEqual({ phase: "STARTING", lastEventSequence: 1 });
  });

  it("returns null when the text holds no status", () => {
    expect(findLastRunnerStatus("")).toBeNull();
    expect(findLastRunnerStatus("some log\nanother log line\n")).toBeNull();
  });
});

describe("join request environment value", () => {
  it("round-trips a join request through the environment value", () => {
    const request = buildJoinRequest();
    const encoded = encodeJoinRequestEnv(request);

    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(decodeJoinRequestEnv(encoded)).toEqual(request);
  });

  it("round-trips non-ASCII text", () => {
    const request = buildJoinRequest({ displayName: "Notetaker dla Łukasza 🎙️" });

    expect(decodeJoinRequestEnv(encodeJoinRequestEnv(request))).toEqual(request);
  });

  it("throws when the value is missing or empty", () => {
    for (const value of [undefined, "", "  "]) {
      expect(() => decodeJoinRequestEnv(value)).toThrow(
        new Error("NOTETAKER_RUNNER_JOIN_REQUEST must be set")
      );
    }
  });

  it("throws when the value is not base64 or not JSON", () => {
    const message = "NOTETAKER_RUNNER_JOIN_REQUEST must be base64 of a JSON join request";

    expect(() => decodeJoinRequestEnv("%%%")).toThrow(new Error(message));
    expect(() => decodeJoinRequestEnv(toBase64("not json"))).toThrow(new Error(message));
  });

  it("throws naming invalid fields without echoing values", () => {
    const invalid = buildJoinRequest({
      meetingUrl: "SENTINEL-not-a-url",
      limits: { ...buildJoinRequest().limits, maxDurationSeconds: 0 },
    });

    let message = "";
    try {
      decodeJoinRequestEnv(toBase64(JSON.stringify(invalid)));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("NOTETAKER_RUNNER_JOIN_REQUEST is not a valid join request; invalid fields: ");
    expect(message).toContain("meetingUrl");
    expect(message).toContain("limits.maxDurationSeconds");
    expect(message).not.toContain("SENTINEL");
  });
});
