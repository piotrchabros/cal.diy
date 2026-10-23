import type { NotetakerPlatformDto } from "@calcom/lib/dto/NotetakerStateDto";
import { describe, expect, it } from "vitest";
import {
  buildAdHocBookingMetadata,
  cleanMeetingLinkInput,
  isAdHocMeetingActive,
  parseAdHocMeetingUrl,
  readAdHocBookingMetadata,
} from "./adHocMeeting";

const BOTH_PLATFORMS: NotetakerPlatformDto[] = ["GOOGLE_MEET", "MICROSOFT_TEAMS"];

const parse = (raw: string, enabledPlatforms: NotetakerPlatformDto[] = BOTH_PLATFORMS) =>
  parseAdHocMeetingUrl(raw, enabledPlatforms);
const ok = (meetingUrl: string, platform: NotetakerPlatformDto = "GOOGLE_MEET") => ({
  ok: true,
  platform,
  meetingUrl,
});
const invalid = { ok: false, reason: "INVALID_MEETING_LINK" };
const unsupported = { ok: false, reason: "UNSUPPORTED_PLATFORM" };
const wrapped = { ok: false, reason: "WRAPPED_MEETING_LINK" };

const THREAD = "19:meeting_NjU5YTk2ZDUtYzJmMS00ZjQ5LWE4YzEtNjZhYmY2YTQ5ZWNh@thread.v2";
const CONTEXT = '{"Tid":"72f988bf-86f1-41af-91ab-2d7cd011db47","Oid":"4b8a1c2e-0000-4000-8000-000000000001"}';
const ENCODED_THREAD = "19%3ameeting_NjU5YTk2ZDUtYzJmMS00ZjQ5LWE4YzEtNjZhYmY2YTQ5ZWNh%40thread.v2";
const CANONICAL_LONG_LINK = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(THREAD)}/0?context=${encodeURIComponent(CONTEXT)}`;

const longLink = (context: string | null = encodeURIComponent(CONTEXT), extra = "") =>
  `https://teams.microsoft.com/l/meetup-join/${ENCODED_THREAD}/0${context === null ? "" : `?context=${context}`}${extra}`;

describe("parseAdHocMeetingUrl", () => {
  it("accepts a valid code", () => {
    expect(parse("https://meet.google.com/abc-defg-hij")).toEqual(ok("https://meet.google.com/abc-defg-hij"));
  });

  it("trims whitespace and normalises to lower case", () => {
    expect(parse("  HTTPS://Meet.Google.com/ABC-DEFG-HIJ \n")).toEqual(
      ok("https://meet.google.com/abc-defg-hij")
    );
  });

  it("drops query and hash", () => {
    expect(parse("https://meet.google.com/abc-defg-hij?authuser=1#x")).toEqual(
      ok("https://meet.google.com/abc-defg-hij")
    );
  });

  it("accepts a trailing slash", () => {
    expect(parse("https://meet.google.com/abc-defg-hij/")).toEqual(
      ok("https://meet.google.com/abc-defg-hij")
    );
  });

  it.each([
    "https://meet.google.com/meet/vgx-mcww-wqf",
    "https://meet.google.com/meet/VGX-MCWW-WQF/",
  ])("accepts the /meet/ path form and stores the canonical link: %s", (input) => {
    expect(parse(input)).toEqual(ok("https://meet.google.com/vgx-mcww-wqf"));
  });

  it.each([
    ["trailing zero-width space", "https://meet.google.com/xrs-kdyt-mzi\u200b"],
    ["leading byte order mark", "\ufeffhttps://meet.google.com/xrs-kdyt-mzi"],
    ["left-to-right marks around", "\u200ehttps://meet.google.com/xrs-kdyt-mzi\u200e"],
    ["zero-width joiner inside the code", "https://meet.google.com/xrs-\u200dkdyt-mzi"],
    ["right-to-left mark and word joiner inside", "https://meet.google.com/xrs-\u200fkdyt-\u2060mzi"],
    ["no-break space and newline at the ends", "\u00a0https://meet.google.com/xrs-kdyt-mzi\n"],
  ])("ignores invisible characters: %s", (_name, input) => {
    expect(parse(input)).toEqual(ok("https://meet.google.com/xrs-kdyt-mzi"));
  });

  it("still rejects a lookalike host that hides a zero-width space", () => {
    expect(parse("https://meet.google.com\u200b.evil.com/abc-defg-hij")).toEqual(invalid);
  });

  it.each([
    ["http protocol", "http://meet.google.com/abc-defg-hij"],
    ["suffix host", "https://meet.google.com.evil.com/abc-defg-hij"],
    ["host in path", "https://evil.com/meet.google.com/abc-defg-hij"],
    ["landing page", "https://meet.google.com/landing"],
    ["root path", "https://meet.google.com/"],
    ["extra path segment", "https://meet.google.com/abc-defg-hij/extra"],
    ["other path prefix", "https://meet.google.com/foo/abc-defg-hij"],
    ["doubled /meet/ prefix", "https://meet.google.com/meet/meet/abc-defg-hij"],
    ["userinfo", "https://user:pass@meet.google.com/abc-defg-hij"],
    ["username only", "https://user@meet.google.com/abc-defg-hij"],
    ["port", "https://meet.google.com:8443/abc-defg-hij"],
    ["unknown host", "https://example.com/abc-defg-hij"],
    ["garbage", "not a url"],
    ["empty", ""],
  ])("rejects %s", (_name, input) => {
    expect(parse(input)).toEqual(invalid);
  });

  it("reports a Meet link as unsupported when only Teams is enabled", () => {
    expect(parse("https://meet.google.com/abc-defg-hij", ["MICROSOFT_TEAMS"])).toEqual(unsupported);
  });

  it("reports a Teams link as unsupported when only Meet is enabled", () => {
    expect(parse("https://teams.microsoft.com/meet/123456789012?p=AbCdEf", ["GOOGLE_MEET"])).toEqual(
      unsupported
    );
  });

  it("rejects every link when no platform is enabled", () => {
    expect(parse("https://meet.google.com/abc-defg-hij", [])).toEqual(unsupported);
  });

  it("rejects input longer than the maximum length", () => {
    expect(parse(`https://meet.google.com/abc-defg-hij?x=${"a".repeat(2048)}`)).toEqual(invalid);
  });

  it.each([
    "https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fmeet.google.com%2Fabc-defg-hij",
    "https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fmeet%2F123456789012%3Fp%3DAbCdEf",
    "https://urldefense.com/v3/__https://teams.microsoft.com/meet/123456789012?p=AbCdEf__;!!abc",
    "https://urldefense.proofpoint.com/v2/url?u=https-3A__meet.google.com_abc-2Ddefg-2Dhij",
    "https://protect-eu.mimecast.com/s/abcdef?domain=teams.microsoft.com",
    "https://protect.mimecast.com/s/abcdef?domain=meet.google.com",
  ])("reports an email security wrapper without unwrapping it: %s", (input) => {
    expect(parse(input)).toEqual(wrapped);
  });

  it("does not treat a lookalike of a wrapper host as a wrapper", () => {
    expect(parse("https://safelinks.protection.outlook.com.evil.com/?url=x")).toEqual(invalid);
  });
});

describe("parseAdHocMeetingUrl with Microsoft Teams links", () => {
  it("canonicalises a long link, keeping the context and dropping other params and the hash", () => {
    expect(parse(longLink(undefined, "&anon=true&deeplinkId=abc#fragment"))).toEqual(
      ok(CANONICAL_LONG_LINK, "MICROSOFT_TEAMS")
    );
    expect(CANONICAL_LONG_LINK).toBe(
      "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_NjU5YTk2ZDUtYzJmMS00ZjQ5LWE4YzEtNjZhYmY2YTQ5ZWNh%40thread.v2/0?context=%7B%22Tid%22%3A%2272f988bf-86f1-41af-91ab-2d7cd011db47%22%2C%22Oid%22%3A%224b8a1c2e-0000-4000-8000-000000000001%22%7D"
    );
  });

  it("accepts a long link whose context JSON was pasted unencoded", () => {
    expect(parse(longLink(CONTEXT))).toEqual(ok(CANONICAL_LONG_LINK, "MICROSOFT_TEAMS"));
  });

  it("accepts a long link with a trailing slash and a raw thread id", () => {
    const input = `https://teams.microsoft.com/l/meetup-join/${THREAD}/0/?context=${encodeURIComponent(CONTEXT)}`;
    expect(parse(input)).toEqual(ok(CANONICAL_LONG_LINK, "MICROSOFT_TEAMS"));
  });

  it.each([
    ["missing context", longLink(null)],
    ["empty context", longLink("")],
    ["non-JSON context", longLink("not-json")],
    ["JSON array context", longLink(encodeURIComponent('["Tid"]'))],
    ["JSON without Tid", longLink(encodeURIComponent('{"Oid":"abc"}'))],
    ["non-string Tid", longLink(encodeURIComponent('{"Tid":42}'))],
    ["context over the length limit", longLink(encodeURIComponent(`{"Tid":"${"a".repeat(1100)}"}`))],
    [
      "thread that is not a meeting thread",
      `https://teams.microsoft.com/l/meetup-join/abc/0?context=${encodeURIComponent(CONTEXT)}`,
    ],
    [
      "thread with a malformed escape",
      `https://teams.microsoft.com/l/meetup-join/19%3Ameeting%E0%A4%A/0?context=${encodeURIComponent(CONTEXT)}`,
    ],
    [
      "thread with characters outside the allowed set",
      `https://teams.microsoft.com/l/meetup-join/19%3Ameeting%3Cscript%3E/0?context=${encodeURIComponent(CONTEXT)}`,
    ],
    [
      "thread over the length limit",
      `https://teams.microsoft.com/l/meetup-join/19%3A${"a".repeat(260)}/0?context=${encodeURIComponent(CONTEXT)}`,
    ],
    [
      "non-numeric message id",
      `https://teams.microsoft.com/l/meetup-join/${ENCODED_THREAD}/abc?context=${encodeURIComponent(CONTEXT)}`,
    ],
    [
      "extra path segment",
      `https://teams.microsoft.com/l/meetup-join/${ENCODED_THREAD}/0/extra?context=${encodeURIComponent(CONTEXT)}`,
    ],
    [
      "long link on teams.live.com",
      `https://teams.live.com/l/meetup-join/${ENCODED_THREAD}/0?context=${encodeURIComponent(CONTEXT)}`,
    ],
  ])("rejects a long link with %s", (_name, input) => {
    expect(parse(input)).toEqual(invalid);
  });

  it("canonicalises a short link, keeping only the passcode", () => {
    expect(parse("https://teams.microsoft.com/meet/123456789012/?p=AbCdEf&anon=true#x")).toEqual(
      ok("https://teams.microsoft.com/meet/123456789012?p=AbCdEf", "MICROSOFT_TEAMS")
    );
  });

  it("accepts a teams.live.com short link", () => {
    expect(parse("https://teams.live.com/meet/9876543210?p=Xy12")).toEqual(
      ok("https://teams.live.com/meet/9876543210?p=Xy12", "MICROSOFT_TEAMS")
    );
  });

  it.each([
    ["missing passcode", "https://teams.microsoft.com/meet/123456789012"],
    ["empty passcode", "https://teams.microsoft.com/meet/123456789012?p="],
    ["passcode with symbols", "https://teams.microsoft.com/meet/123456789012?p=Ab%26c"],
    ["non-numeric id", "https://teams.microsoft.com/meet/abcdefghij?p=AbCdEf"],
    ["too short id", "https://teams.microsoft.com/meet/12345?p=AbCdEf"],
    ["unknown Teams path", "https://teams.microsoft.com/v2/"],
    ["Teams root", "https://teams.microsoft.com/"],
  ])("rejects a short link with %s", (_name, input) => {
    expect(parse(input)).toEqual(invalid);
  });

  it("unwraps a launcher link once into the canonical long link", () => {
    const inner = `/_#/l/meetup-join/${ENCODED_THREAD}/0?context=${encodeURIComponent(CONTEXT)}`;
    const input = `https://teams.microsoft.com/dl/launcher/launcher.html?url=${encodeURIComponent(inner)}&type=meetup-join&directDl=true`;
    expect(parse(input)).toEqual(ok(CANONICAL_LONG_LINK, "MICROSOFT_TEAMS"));
  });

  it.each([
    ["a foreign url", "https://evil.com/l/meetup-join/x"],
    ["a short-link path", "/_#/meet/123456789012?p=AbCdEf"],
    ["a nested launcher", "/_#/dl/launcher/launcher.html?url=x"],
    ["no url at all", null],
  ])("rejects a launcher link carrying %s", (_name, target) => {
    const query = target === null ? "" : `?url=${encodeURIComponent(target)}`;
    expect(parse(`https://teams.microsoft.com/dl/launcher/launcher.html${query}`)).toEqual(invalid);
  });

  it.each([
    ["suffix host", "https://teams.microsoft.com.evil.com/meet/123456789012?p=AbCdEf"],
    ["prefixed host", "https://evilteams.microsoft.com/meet/123456789012?p=AbCdEf"],
    ["host in path", `https://evil.com/teams.microsoft.com/l/meetup-join/${ENCODED_THREAD}/0`],
    ["userinfo", "https://user:pass@teams.microsoft.com/meet/123456789012?p=AbCdEf"],
    ["port", "https://teams.microsoft.com:8443/meet/123456789012?p=AbCdEf"],
    ["http protocol", "http://teams.microsoft.com/meet/123456789012?p=AbCdEf"],
  ])("rejects a lookalike or unsafe Teams link: %s", (_name, input) => {
    expect(parse(input)).toEqual(invalid);
  });

  it("ignores zero-width characters pasted inside a Teams link", () => {
    expect(parse("https://teams.\u200bmicrosoft.com/meet/1234\u200d56789012?p=AbC\u2060dEf\u200b")).toEqual(
      ok("https://teams.microsoft.com/meet/123456789012?p=AbCdEf", "MICROSOFT_TEAMS")
    );
  });

  it.each([
    "https://teams.microsoft.us/meet/123456789012?p=AbCdEf",
    "https://gov.teams.microsoft.us/l/meetup-join/x/0",
    "https://dod.teams.microsoft.us/meet/123456789012?p=AbCdEf",
    "https://teams.cloud.microsoft/meet/123456789012?p=AbCdEf",
  ])("reports a government or new-domain Teams link as unsupported: %s", (input) => {
    expect(parse(input)).toEqual(unsupported);
  });
});

describe("cleanMeetingLinkInput", () => {
  it("strips format characters and trims", () => {
    expect(cleanMeetingLinkInput(" \u200bhttps://meet.google.com/abc-defg-hij\u200e ")).toBe(
      "https://meet.google.com/abc-defg-hij"
    );
  });

  it("reduces input made only of invisible characters to an empty string", () => {
    expect(cleanMeetingLinkInput("\u200b\u200d")).toBe("");
  });
});

describe("ad-hoc booking metadata", () => {
  it("round-trips without a sharing team", () => {
    const metadata = buildAdHocBookingMetadata({ sharingTeamId: null });
    expect(metadata).toEqual({ notetakerAdHoc: "true" });
    expect(readAdHocBookingMetadata(metadata)).toEqual({ isAdHoc: true, sharingTeamId: null });
  });

  it("round-trips with a sharing team", () => {
    const metadata = buildAdHocBookingMetadata({ sharingTeamId: 42 });
    expect(metadata).toEqual({ notetakerAdHoc: "true", notetakerSharingTeamId: "42" });
    expect(readAdHocBookingMetadata(metadata)).toEqual({ isAdHoc: true, sharingTeamId: 42 });
  });

  it.each([null, undefined, "x", 5, true, [], ["notetakerAdHoc"], {}])("reads garbage %j safely", (value) => {
    expect(readAdHocBookingMetadata(value)).toEqual({ isAdHoc: false, sharingTeamId: null });
  });

  it.each([
    [{ notetakerAdHoc: true }, false],
    [{ notetakerAdHoc: "TRUE" }, false],
    [{ notetakerAdHoc: "1" }, false],
  ])("only treats the exact string true as ad hoc: %j", (value, isAdHoc) => {
    expect(readAdHocBookingMetadata(value).isAdHoc).toBe(isAdHoc);
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "1e3",
    " 7",
    "07",
    "",
    "abc",
    "9007199254740993",
    7,
    null,
    {},
  ])("rejects sharing team id %j", (value) => {
    expect(readAdHocBookingMetadata({ notetakerSharingTeamId: value }).sharingTeamId).toBeNull();
  });
});

describe("isAdHocMeetingActive", () => {
  const armed = { enabled: true, pendingDispatch: true };
  const dispatched = { enabled: true, pendingDispatch: false };
  const disabled = { enabled: false, pendingDispatch: false };

  it.each([
    ["no choice and no session yet", null, null, true],
    ["an armed choice without a session", armed, null, true],
    ["a dispatched choice without a session", dispatched, null, true],
    ["a disabled choice without a session", disabled, null, false],
    ["a SCHEDULED session", dispatched, "SCHEDULED", true],
    ["a WAITING_TO_BE_ADMITTED session", dispatched, "WAITING_TO_BE_ADMITTED", true],
    ["a TRANSCRIBING session", dispatched, "TRANSCRIBING", true],
    ["a PROCESSING session", dispatched, "PROCESSING", true],
    ["a live session after the choice was disabled", disabled, "TRANSCRIBING", true],
    ["a READY session", dispatched, "READY", false],
    ["an ENDED_EARLY session", dispatched, "ENDED_EARLY", false],
    ["a FAILED session", dispatched, "FAILED", false],
    ["a READY session without a choice", null, "READY", false],
    ["a FAILED session re-armed for another dispatch", armed, "FAILED", true],
  ] as const)("%s", (_label, choice, latestSessionStatus, expected) => {
    expect(isAdHocMeetingActive({ choice, latestSessionStatus })).toBe(expected);
  });
});
