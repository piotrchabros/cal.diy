import { describe, expect, it } from "vitest";
import {
  buildAdHocBookingMetadata,
  cleanMeetingLinkInput,
  parseAdHocMeetingUrl,
  readAdHocBookingMetadata,
} from "./adHocMeeting";

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
    "https://meet.google.com/meet/vgx-mcww-wqf",
    "https://meet.google.com/meet/VGX-MCWW-WQF/",
  ])("accepts the /meet/ path form and stores the canonical link: %s", (input) => {
    expect(parseAdHocMeetingUrl(input)).toEqual(ok("https://meet.google.com/vgx-mcww-wqf"));
  });

  it.each([
    ["trailing zero-width space", "https://meet.google.com/xrs-kdyt-mzi\u200b"],
    ["leading byte order mark", "\ufeffhttps://meet.google.com/xrs-kdyt-mzi"],
    ["left-to-right marks around", "\u200ehttps://meet.google.com/xrs-kdyt-mzi\u200e"],
    ["zero-width joiner inside the code", "https://meet.google.com/xrs-\u200dkdyt-mzi"],
    ["right-to-left mark and word joiner inside", "https://meet.google.com/xrs-\u200fkdyt-\u2060mzi"],
    ["no-break space and newline at the ends", "\u00a0https://meet.google.com/xrs-kdyt-mzi\n"],
  ])("ignores invisible characters: %s", (_name, input) => {
    expect(parseAdHocMeetingUrl(input)).toEqual(ok("https://meet.google.com/xrs-kdyt-mzi"));
  });

  it("still rejects a lookalike host that hides a zero-width space", () => {
    expect(parseAdHocMeetingUrl("https://meet.google.com\u200b.evil.com/abc-defg-hij")).toEqual(invalid);
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
    expect(parseAdHocMeetingUrl(input)).toEqual(invalid);
  });

  it.each([
    "https://teams.microsoft.com/l/meetup-join/abc",
    "https://teams.live.com/meet/123",
  ])("reports a Teams link as an unsupported platform: %s", (input) => {
    expect(parseAdHocMeetingUrl(input)).toEqual({ ok: false, reason: "UNSUPPORTED_PLATFORM" });
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
