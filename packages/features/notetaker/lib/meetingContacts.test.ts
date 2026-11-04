import { describe, expect, it } from "vitest";
import {
  isCalendarResourceEmail,
  MAX_CALENDAR_CONTACTS,
  MAX_MANUAL_CONTACTS,
  normalizeMeetingContactEmails,
  normalizeMeetingContacts,
  parseContactEmailInput,
} from "./meetingContacts";

describe("constants", () => {
  it("exposes the caps", () => {
    expect(MAX_MANUAL_CONTACTS).toBe(20);
    expect(MAX_CALENDAR_CONTACTS).toBe(50);
  });
});

describe("isCalendarResourceEmail", () => {
  it("detects Google resource calendars", () => {
    expect(isCalendarResourceEmail("c_123@resource.calendar.google.com")).toBe(true);
    expect(isCalendarResourceEmail("C_123@Resource.Calendar.Google.com")).toBe(true);
  });

  it("detects Office365 room mailboxes", () => {
    expect(isCalendarResourceEmail("room-4a@contoso.onmicrosoft.com")).toBe(true);
  });

  it("keeps regular emails", () => {
    expect(isCalendarResourceEmail("ada@example.com")).toBe(false);
    expect(isCalendarResourceEmail("roomba@example.com")).toBe(false);
  });
});

describe("normalizeMeetingContactEmails", () => {
  it("trims, lowercases, dedupes and keeps order", () => {
    expect(normalizeMeetingContactEmails([" B@x.com", "a@x.com", "b@X.com"], [], 10)).toEqual([
      "b@x.com",
      "a@x.com",
    ]);
  });

  it("drops invalid, excluded and resource emails", () => {
    expect(
      normalizeMeetingContactEmails(
        ["nope", "owner@x.com", "c_1@resource.calendar.google.com", "ok@x.com", ""],
        ["OWNER@x.com"],
        10
      )
    ).toEqual(["ok@x.com"]);
  });

  it("truncates to max", () => {
    expect(normalizeMeetingContactEmails(["a@x.com", "b@x.com", "c@x.com"], [], 2)).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });
});

describe("normalizeMeetingContacts", () => {
  it("keeps the first non-empty name", () => {
    expect(
      normalizeMeetingContacts(
        [
          { email: "a@x.com", name: null },
          { email: "A@x.com", name: "  Ada " },
          { email: "a@x.com", name: "Other" },
          { email: "b@x.com", name: "  " },
        ],
        [],
        10
      )
    ).toEqual([
      { email: "a@x.com", name: "Ada" },
      { email: "b@x.com", name: null },
    ]);
  });

  it("applies exclusions and max", () => {
    expect(
      normalizeMeetingContacts(
        [
          { email: "me@x.com", name: "Me" },
          { email: "a@x.com", name: "A" },
          { email: "b@x.com", name: "B" },
        ],
        ["me@x.com"],
        1
      )
    ).toEqual([{ email: "a@x.com", name: "A" }]);
  });
});

describe("parseContactEmailInput", () => {
  it("splits on commas, semicolons and whitespace", () => {
    expect(parseContactEmailInput("a@x.com, b@x.com;c@x.com\nd@x.com  e@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
      "e@x.com",
    ]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseContactEmailInput("  \n ")).toEqual([]);
  });
});
