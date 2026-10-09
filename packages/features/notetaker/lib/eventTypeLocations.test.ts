import { describe, expect, it } from "vitest";
import { parseEventTypeLocations } from "./eventTypeLocations";

describe("parseEventTypeLocations", () => {
  it("returns the location types in order", () => {
    const result = parseEventTypeLocations([
      { type: "integrations:daily" },
      { type: "inPerson", address: "1 Main St" },
      { type: "link", link: "https://example.com/room" },
    ]);

    expect(result.map((location) => location.type)).toEqual(["integrations:daily", "inPerson", "link"]);
  });

  it("keeps the known extra fields", () => {
    const locations = [
      { type: "inPerson", address: "1 Main St" },
      { type: "link", link: "https://example.com/room" },
    ];

    expect(parseEventTypeLocations(locations)).toEqual(locations);
  });

  it("returns an empty list for an empty array", () => {
    expect(parseEventTypeLocations([])).toEqual([]);
  });

  it("returns an empty list for null", () => {
    expect(parseEventTypeLocations(null)).toEqual([]);
  });

  it("returns an empty list for undefined", () => {
    expect(parseEventTypeLocations(undefined)).toEqual([]);
  });

  it("returns an empty list for a string", () => {
    expect(parseEventTypeLocations("integrations:daily")).toEqual([]);
  });

  it("returns an empty list for a plain object", () => {
    expect(parseEventTypeLocations({ type: "integrations:daily" })).toEqual([]);
  });

  it("returns an empty list when a type is not a string", () => {
    expect(parseEventTypeLocations([{ type: 5 }])).toEqual([]);
  });

  it("returns an empty list for the whole array when one location has a malformed link", () => {
    expect(
      parseEventTypeLocations([{ type: "integrations:daily" }, { type: "link", link: "not a url" }])
    ).toEqual([]);
  });
});
