// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isJoinableMeetingUrl } from "./meetingUrl";
import type { PlatformName } from "./PlatformAdapter";

type Row = [PlatformName, string];

describe("isJoinableMeetingUrl", () => {
  describe("accepted links", () => {
    it.each<Row>([
      ["GOOGLE_MEET", "https://meet.google.com/abc-defg-hij"],
      ["GOOGLE_MEET", "http://meet.google.com/abc-defg-hij"],
      ["GOOGLE_MEET", "https://meet.google.com/lookup/abc123?authuser=0"],
      [
        "MICROSOFT_TEAMS",
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d",
      ],
      ["MICROSOFT_TEAMS", "https://teams.live.com/meet/9312345678901"],
      ["MICROSOFT_TEAMS", "http://teams.microsoft.com/l/meetup-join/x"],
    ])("accepts %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(true);
    });

    // The URL parser lowercases scheme and host, so casing must not matter.
    it.each<Row>([
      ["GOOGLE_MEET", "HTTPS://MEET.GOOGLE.COM/abc-defg-hij"],
      ["MICROSOFT_TEAMS", "https://Teams.Microsoft.com/l/meetup-join/x"],
    ])("accepts mixed case %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(true);
    });

    // The app classifies by hostname, so the bot must not refuse a link the app accepted.
    it.each<Row>([
      ["GOOGLE_MEET", "https://meet.google.com:443/abc-defg-hij"],
      ["GOOGLE_MEET", "https://meet.google.com:8443/abc-defg-hij"],
    ])("ignores the port in %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(true);
    });

    // Pasted links often carry stray whitespace and the URL parser trims it.
    it("accepts surrounding whitespace", () => {
      expect(isJoinableMeetingUrl("GOOGLE_MEET", "  https://meet.google.com/abc-defg-hij  ")).toBe(true);
    });
  });

  describe("platform and host mismatch", () => {
    it.each<Row>([
      ["GOOGLE_MEET", "https://teams.microsoft.com/l/meetup-join/x"],
      ["GOOGLE_MEET", "https://teams.live.com/meet/9312345678901"],
      ["MICROSOFT_TEAMS", "https://meet.google.com/abc-defg-hij"],
    ])("rejects %s with %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });
  });

  describe("wrong, subdomain and lookalike hosts", () => {
    it.each<Row>([
      ["GOOGLE_MEET", "https://zoom.us/j/123"],
      ["GOOGLE_MEET", "https://example.com/abc"],
      ["GOOGLE_MEET", "https://google.com/meet/abc"],
      ["MICROSOFT_TEAMS", "https://zoom.us/j/123"],
      ["MICROSOFT_TEAMS", "https://example.com/abc"],
      ["MICROSOFT_TEAMS", "https://google.com/meet/abc"],
    ])("rejects unrelated host for %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    // Suffix matching would let any subdomain, including attacker-controlled ones, through.
    it.each<Row>([
      ["GOOGLE_MEET", "https://www.meet.google.com/abc"],
      ["MICROSOFT_TEAMS", "https://foo.teams.microsoft.com/l/x"],
      ["MICROSOFT_TEAMS", "https://eu.teams.live.com/meet/1"],
    ])("rejects subdomain for %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    it.each<Row>([
      ["GOOGLE_MEET", "https://meet.google.com.evil.example/abc"],
      ["MICROSOFT_TEAMS", "https://teams.microsoft.com.evil.example/l/x"],
    ])("rejects suffix lookalike for %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    it.each<Row>([
      ["GOOGLE_MEET", "https://evilmeet.google.com/abc"],
      ["MICROSOFT_TEAMS", "https://xteams.live.com/meet/1"],
      ["GOOGLE_MEET", "https://meet-google.com/abc"],
    ])("rejects prefix lookalike for %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    it.each<Row>([
      ["GOOGLE_MEET", "https://google.com/abc"],
      ["MICROSOFT_TEAMS", "https://microsoft.com/l/x"],
      ["MICROSOFT_TEAMS", "https://teams.microsoft.us/l/x"],
      ["MICROSOFT_TEAMS", "https://live.com/meet/1"],
    ])("rejects parent or sibling domain for %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    // Everything before the @ is userinfo, so the real host here is evil.example.
    it("rejects the userinfo trick", () => {
      expect(isJoinableMeetingUrl("GOOGLE_MEET", "https://meet.google.com@evil.example/abc")).toBe(false);
    });

    it.each<Row>([
      ["GOOGLE_MEET", "https://evil.example/meet.google.com/abc"],
      ["GOOGLE_MEET", "https://evil.example/?u=https://meet.google.com/abc"],
    ])("rejects a host that only appears in the path or query: %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    // The parser keeps the trailing dot in hostname, so it is not an exact match.
    it("rejects a trailing-dot host", () => {
      expect(isJoinableMeetingUrl("GOOGLE_MEET", "https://meet.google.com./abc")).toBe(false);
    });
  });

  describe("path", () => {
    it.each<Row>([
      ["GOOGLE_MEET", "https://meet.google.com"],
      ["GOOGLE_MEET", "https://meet.google.com/"],
    ])("rejects a bare host %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    // Query and fragment do not count towards the pathname, so they cannot make a bare host joinable.
    it.each<Row>([
      ["GOOGLE_MEET", "https://meet.google.com/?code=abc"],
      ["GOOGLE_MEET", "https://meet.google.com/#abc"],
    ])("rejects a query or fragment without a path %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    it.each<Row>([
      ["MICROSOFT_TEAMS", "https://teams.microsoft.com/"],
      ["MICROSOFT_TEAMS", "https://teams.live.com"],
    ])("rejects a bare Teams host %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });
  });

  describe("other schemes", () => {
    it.each<Row>([
      ["GOOGLE_MEET", "ftp://meet.google.com/abc"],
      ["GOOGLE_MEET", "ws://meet.google.com/abc"],
      ["GOOGLE_MEET", "wss://meet.google.com/abc"],
      ["GOOGLE_MEET", "file:///meet.google.com/abc"],
    ])("rejects non-http scheme %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    it.each<Row>([
      ["GOOGLE_MEET", "javascript:alert(1)"],
      ["GOOGLE_MEET", "data:text/plain,meet.google.com/abc"],
      ["GOOGLE_MEET", "mailto:a@meet.google.com"],
    ])("rejects opaque scheme %s %s", (platform, url) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    // Teams deep links open the desktop client, which a headless bot cannot use.
    it("rejects the msteams deep-link scheme", () => {
      expect(isJoinableMeetingUrl("MICROSOFT_TEAMS", "msteams://teams.microsoft.com/l/meetup-join/x")).toBe(
        false
      );
    });
  });

  describe("unparsable input", () => {
    it.each<Row>([
      ["GOOGLE_MEET", ""],
      ["GOOGLE_MEET", "   "],
      ["GOOGLE_MEET", "not a url"],
      ["MICROSOFT_TEAMS", ""],
      ["MICROSOFT_TEAMS", "not a url"],
    ])("returns false without throwing for %s %j", (platform, url) => {
      expect(() => isJoinableMeetingUrl(platform, url)).not.toThrow();
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    // Without a scheme the parser has no base to resolve against and throws.
    it.each<Row>([
      ["GOOGLE_MEET", "meet.google.com/abc-defg-hij"],
      ["GOOGLE_MEET", "//meet.google.com/abc"],
    ])("returns false without throwing for a missing scheme %s %s", (platform, url) => {
      expect(() => isJoinableMeetingUrl(platform, url)).not.toThrow();
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });

    // "https:///abc" parses with host "abc" rather than throwing, so it is rejected by the host check.
    it.each<Row>([
      ["GOOGLE_MEET", "https://"],
      ["GOOGLE_MEET", "https:///abc"],
      ["GOOGLE_MEET", "http://[::1/abc"],
    ])("returns false without throwing for a malformed authority %s %s", (platform, url) => {
      expect(() => isJoinableMeetingUrl(platform, url)).not.toThrow();
      expect(isJoinableMeetingUrl(platform, url)).toBe(false);
    });
  });

  describe("purity", () => {
    it.each<[PlatformName, string, boolean]>([
      ["GOOGLE_MEET", "https://meet.google.com/abc-defg-hij", true],
      ["GOOGLE_MEET", "https://evil.example/abc", false],
    ])("gives the same answer twice for %s %s", (platform, url, expected) => {
      expect(isJoinableMeetingUrl(platform, url)).toBe(expected);
      expect(isJoinableMeetingUrl(platform, url)).toBe(expected);
    });
  });
});
