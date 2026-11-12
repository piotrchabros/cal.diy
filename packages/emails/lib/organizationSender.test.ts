import type { CalendarEvent } from "@calcom/types/Calendar";
import { describe, expect, it } from "vitest";
import { applyOrganizationSender, parseFromHeader, senderScopeFromCalEvent } from "./organizationSender";

const defaults = { address: "notifications@cal.example", systemNames: ["Cal Notifications", "Cal.diy"] };

describe("parseFromHeader", () => {
  it("parses a name and address", () => {
    expect(parseFromHeader("Cal.diy <notifications@cal.example>")).toEqual({
      name: "Cal.diy",
      address: "notifications@cal.example",
    });
  });

  it("parses a bare address", () => {
    expect(parseFromHeader("notifications@cal.example")).toEqual({
      name: null,
      address: "notifications@cal.example",
    });
  });
});

describe("applyOrganizationSender", () => {
  it("replaces a system name and the default address", () => {
    expect(
      applyOrganizationSender(
        "Cal.diy <notifications@cal.example>",
        { name: "Acme", address: "hello@acme.com" },
        defaults
      )
    ).toEqual({ from: "Acme <hello@acme.com>", customized: true });
  });

  it("keeps an organizer name but replaces the default address", () => {
    expect(
      applyOrganizationSender(
        "Jane Host <notifications@cal.example>",
        { name: "Acme", address: "hello@acme.com" },
        defaults
      )
    ).toEqual({ from: "Jane Host <hello@acme.com>", customized: true });
  });

  it("matches the default address case-insensitively", () => {
    expect(
      applyOrganizationSender(
        "Cal Notifications <Notifications@CAL.example>",
        { name: null, address: "hello@acme.com" },
        defaults
      )
    ).toEqual({ from: "Cal Notifications <hello@acme.com>", customized: true });
  });

  it("leaves a non-default address untouched", () => {
    expect(
      applyOrganizationSender(
        "Cal.diy <other@cal.example>",
        { name: null, address: "hello@acme.com" },
        defaults
      )
    ).toEqual({ from: "Cal.diy <other@cal.example>", customized: false });
  });

  it("replaces a bare default address", () => {
    expect(
      applyOrganizationSender(
        "notifications@cal.example",
        { name: "Acme", address: "hello@acme.com" },
        defaults
      )
    ).toEqual({ from: "hello@acme.com", customized: true });
  });

  it("changes only the name when no address is configured", () => {
    expect(
      applyOrganizationSender(
        "Cal Notifications <notifications@cal.example>",
        { name: "Acme", address: null },
        defaults
      )
    ).toEqual({ from: "Acme <notifications@cal.example>", customized: true });
  });

  it("reports no change for an empty sender", () => {
    const from = "Cal.diy <notifications@cal.example>";
    expect(applyOrganizationSender(from, { name: null, address: null }, defaults)).toEqual({
      from,
      customized: false,
    });
  });
});

describe("senderScopeFromCalEvent", () => {
  const organizer = { id: 7, email: "host@example.com" } as CalendarEvent["organizer"];

  it("prefers the organization", () => {
    expect(senderScopeFromCalEvent({ organizationId: 3, organizer })).toEqual({ organizationId: 3 });
  });

  it("falls back to the organizer id", () => {
    expect(senderScopeFromCalEvent({ organizationId: null, organizer })).toEqual({ userId: 7 });
  });

  it("falls back to the organizer email", () => {
    expect(
      senderScopeFromCalEvent({ organizer: { ...organizer, id: undefined } as CalendarEvent["organizer"] })
    ).toEqual({ userEmail: "host@example.com" });
  });

  it("returns null without organizer details", () => {
    expect(
      senderScopeFromCalEvent({
        organizer: { ...organizer, id: undefined, email: "" } as CalendarEvent["organizer"],
      })
    ).toBeNull();
  });
});
