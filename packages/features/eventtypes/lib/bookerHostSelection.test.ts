import { SchedulingType } from "@calcom/prisma/enums";
import { describe, expect, it } from "vitest";
import {
  filterBySelectedIds,
  isBookerHostSelectionEnabled,
  parseSelectedHostIdsParam,
  resolveSelectedHostIds,
} from "./bookerHostSelection";

const hosts = [
  { id: 1, email: "Alice@example.com" },
  { id: 2, email: "bob@example.com" },
  { id: 3, email: "carol@example.com" },
];

describe("isBookerHostSelectionEnabled", () => {
  const base = {
    schedulingType: SchedulingType.COLLECTIVE,
    teamId: 5,
    seatsPerTimeSlot: null,
    metadata: { allowBookerToSelectHosts: true },
  };

  it("is enabled for collective team events with the flag", () => {
    expect(isBookerHostSelectionEnabled(base)).toBe(true);
  });

  it("is disabled when the flag is off or missing", () => {
    expect(isBookerHostSelectionEnabled({ ...base, metadata: { allowBookerToSelectHosts: false } })).toBe(
      false
    );
    expect(isBookerHostSelectionEnabled({ ...base, metadata: {} })).toBe(false);
    expect(isBookerHostSelectionEnabled({ ...base, metadata: null })).toBe(false);
  });

  it("is disabled for non-collective events", () => {
    expect(isBookerHostSelectionEnabled({ ...base, schedulingType: SchedulingType.ROUND_ROBIN })).toBe(false);
    expect(isBookerHostSelectionEnabled({ ...base, schedulingType: null })).toBe(false);
  });

  it("is disabled for seated events", () => {
    expect(isBookerHostSelectionEnabled({ ...base, seatsPerTimeSlot: 3 })).toBe(false);
  });

  it("is disabled without a team", () => {
    expect(isBookerHostSelectionEnabled({ ...base, teamId: null })).toBe(false);
  });
});

describe("resolveSelectedHostIds", () => {
  it("returns null when disabled", () => {
    expect(resolveSelectedHostIds({ enabled: false, hosts, requestedHostIds: [1] })).toBeNull();
  });

  it("keeps host order when intersecting", () => {
    expect(resolveSelectedHostIds({ enabled: true, hosts, requestedHostIds: [3, 1] })).toEqual([1, 3]);
  });

  it("drops invalid ids", () => {
    expect(resolveSelectedHostIds({ enabled: true, hosts, requestedHostIds: [2, 99] })).toEqual([2]);
  });

  it("returns null for an empty intersection", () => {
    expect(resolveSelectedHostIds({ enabled: true, hosts, requestedHostIds: [98, 99] })).toBeNull();
  });

  it("returns null when all hosts are selected", () => {
    expect(resolveSelectedHostIds({ enabled: true, hosts, requestedHostIds: [3, 2, 1] })).toBeNull();
  });

  it("returns null with nothing requested and no original booking", () => {
    expect(resolveSelectedHostIds({ enabled: true, hosts })).toBeNull();
    expect(resolveSelectedHostIds({ enabled: true, hosts, requestedHostIds: [] })).toBeNull();
  });

  it("derives from the original booking organizer and attendee emails case-insensitively", () => {
    expect(
      resolveSelectedHostIds({
        enabled: true,
        hosts,
        originalBooking: { userId: 3, attendeeEmails: ["ALICE@EXAMPLE.COM", "guest@example.com"] },
      })
    ).toEqual([1, 3]);
  });

  it("returns null when the original booking maps to nobody or everybody", () => {
    expect(
      resolveSelectedHostIds({ enabled: true, hosts, originalBooking: { userId: null, attendeeEmails: [] } })
    ).toBeNull();
    expect(
      resolveSelectedHostIds({
        enabled: true,
        hosts,
        originalBooking: { userId: 1, attendeeEmails: ["bob@example.com", "carol@example.com"] },
      })
    ).toBeNull();
  });

  it("prefers requested ids over the original booking", () => {
    expect(
      resolveSelectedHostIds({
        enabled: true,
        hosts,
        requestedHostIds: [2],
        originalBooking: { userId: 1, attendeeEmails: ["carol@example.com"] },
      })
    ).toEqual([2]);
  });
});

describe("filterBySelectedIds", () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("returns items unchanged for null ids", () => {
    expect(filterBySelectedIds(items, (i) => i.id, null)).toBe(items);
  });

  it("filters to the selected ids", () => {
    expect(filterBySelectedIds(items, (i) => i.id, [1, 3])).toEqual([{ id: 1 }, { id: 3 }]);
  });
});

describe("parseSelectedHostIdsParam", () => {
  it("parses a comma separated list", () => {
    expect(parseSelectedHostIdsParam("1,59")).toEqual([1, 59]);
  });

  it("ignores NaN, non-positive, non-integer values and duplicates", () => {
    expect(parseSelectedHostIdsParam("1,abc,0,-4,2.5,1, 7 ")).toEqual([1, 7]);
  });

  it("returns null for empty input", () => {
    expect(parseSelectedHostIdsParam("")).toBeNull();
    expect(parseSelectedHostIdsParam(null)).toBeNull();
    expect(parseSelectedHostIdsParam(undefined)).toBeNull();
    expect(parseSelectedHostIdsParam(",,x")).toBeNull();
  });
});
