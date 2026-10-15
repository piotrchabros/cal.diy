import { describe, expect, it } from "vitest";
import { buildAdHocBookingMetadata, parseAdHocMeetingUrl, readAdHocBookingMetadata } from "./adHocMeeting";

const ok = (meetingUrl: string) => ({ ok: true, platform: "GOOGLE_MEET", meetingUrl });
const invalid = { ok: false, reason: "INVALID_MEETING_LINK" };

describe("parseAdHocMeetingUrl", () => {
  it("accepts a valid code", () => {
    expect(parseAdHocMeetingUrl("https://meet.google.com/abc-defg-hij")).toEqual(
      ok("https://meet.google.com/abc-defg-hij")
    );
  });

  it("trims whitespace and normalises to lower case", () => {
    expect(parseAdHocMeetingUrl("  HTTPS://Meet.Google.com/ABC-DEFG-HIJ \n")).toEqual(
      ok("https://meet.google.com/abc-defg-hij")
    );
  });

  it("drops query and hash", () => {
    expect(parseAdHocMeetingUrl("https://meet.google.com/abc-defg-hij?authuser=1#x")).toEqual(
      ok("https://meet.google.com/abc-defg-hij")
    );
  });

  it("accepts a trailing slash", () => {
    expect(parseAdHocMeetingUrl("https://meet.google.com/abc-defg-hij/")).toEqual(
      ok("https://meet.google.com/abc-defg-hij")
    );
  });

  it.each([
    ["http protocol", "http://meet.google.com/abc-defg-hij"],
    ["suffix host", "https://meet.google.com.evil.com/abc-defg-hij"],
    ["host in path", "https://evil.com/meet.google.com/abc-defg-hij"],
    ["landing page", "https://meet.google.com/landing"],
    ["root path", "https://meet.google.com/"],
    ["extra path segment", "https://meet.google.com/abc-defg-hij/extra"],
    ["userinfo", "https://user:pass@meet.google.com/abc-defg-hij"],
    ["username only", "https://user@meet.google.com/abc-defg-hij"],
    ["port", "https://meet.google.com:8443/abc-defg-hij"],
    ["unknown host", "https://example.com/abc-defg-hij"],
    ["garbage", "not a url"],
    ["empty", ""],
  ])("rejects %s", (_name, input) => {
    expect(parseAdHocMeetingUrl(input)).toEqual(invalid);
  });

  it.each([
    "https://teams.microsoft.com/l/meetup-join/abc",
    "https://teams.live.com/meet/123",
  ])("reports a Teams link as an unsupported platform: %s", (input) => {
    expect(parseAdHocMeetingUrl(input)).toEqual({ ok: false, reason: "UNSUPPORTED_PLATFORM" });
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
