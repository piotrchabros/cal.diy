import { describe, expect, it } from "vitest";
import {
  EMAIL_SENDER_ERRORS,
  isSenderDomainAllowed,
  parseSenderAddress,
  parseSenderName,
} from "./emailSenderPolicy";

describe("parseSenderName", () => {
  it("returns null for null and blank input", () => {
    expect(parseSenderName(null)).toBeNull();
    expect(parseSenderName("   ")).toBeNull();
  });

  it("trims and collapses spaces", () => {
    expect(parseSenderName("  Jelly   Match  Team ")).toBe("Jelly Match Team");
  });

  it.each([
    "Evil\r\nBcc: a@b.co",
    "Tab\u0000",
    "Tab\there",
    "a\u007Fb",
    "<x>",
    'Say "hi"',
    "a\\b",
    "a;b",
    "a,b",
    "a:b",
    "(x)",
  ])("rejects %j", (raw) => {
    expect(() => parseSenderName(raw)).toThrow(EMAIL_SENDER_ERRORS.nameInvalid);
  });

  it("rejects names over 100 characters and accepts exactly 100", () => {
    expect(parseSenderName("a".repeat(100))).toHaveLength(100);
    expect(() => parseSenderName("a".repeat(101))).toThrow(EMAIL_SENDER_ERRORS.nameTooLong);
  });
});

describe("parseSenderAddress", () => {
  it("returns null for null and blank input", () => {
    expect(parseSenderAddress(null)).toBeNull();
    expect(parseSenderAddress("  ")).toBeNull();
  });

  it("trims and lowercases", () => {
    expect(parseSenderAddress("  Hello@Cal.JellyMatch.tech ")).toBe("hello@cal.jellymatch.tech");
  });

  it.each([
    "plain",
    "a@b",
    "@jellymatch.tech",
    "a@",
    "a b@jellymatch.tech",
    "a@jelly match.tech",
    "<a@jellymatch.tech>",
    "a,b@jellymatch.tech",
    "a@jellymatch.tech,b@jellymatch.tech",
    'a"b@jellymatch.tech',
    "a\\b@jellymatch.tech",
    "a@jellymatch.tech\r\nBcc: x@y.co",
    "a@-bad.tech",
    "a@jellymatch..tech",
  ])("rejects %j", (raw) => {
    expect(() => parseSenderAddress(raw)).toThrow(EMAIL_SENDER_ERRORS.addressInvalid);
  });

  it("rejects addresses over 254 characters", () => {
    expect(() => parseSenderAddress(`${"a".repeat(250)}@jellymatch.tech`)).toThrow(
      EMAIL_SENDER_ERRORS.addressInvalid
    );
  });
});

describe("isSenderDomainAllowed", () => {
  it("is false without a custom domain", () => {
    expect(isSenderDomainAllowed("a@jellymatch.tech", null)).toBe(false);
  });

  it("allows the custom domain itself and its parents with two or more labels", () => {
    expect(isSenderDomainAllowed("a@cal.jellymatch.tech", "cal.jellymatch.tech")).toBe(true);
    expect(isSenderDomainAllowed("a@jellymatch.tech", "cal.jellymatch.tech")).toBe(true);
  });

  it("rejects bare TLDs, siblings, children and lookalikes", () => {
    expect(isSenderDomainAllowed("a@tech", "cal.jellymatch.tech")).toBe(false);
    expect(isSenderDomainAllowed("a@other.jellymatch.tech", "cal.jellymatch.tech")).toBe(false);
    expect(isSenderDomainAllowed("a@x.cal.jellymatch.tech", "cal.jellymatch.tech")).toBe(false);
    expect(isSenderDomainAllowed("a@eviljellymatch.tech", "cal.jellymatch.tech")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isSenderDomainAllowed("a@JellyMatch.tech", "Cal.JellyMatch.tech")).toBe(true);
  });
});
