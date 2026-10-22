import { describe, expect, it } from "vitest";
import { groupActionItemsByOwner } from "./groupActionItemsByOwner";

describe("groupActionItemsByOwner", () => {
  it("returns no groups for no items", () => {
    expect(groupActionItemsByOwner([])).toEqual([]);
  });

  it("groups by owner in first-appearance order", () => {
    expect(
      groupActionItemsByOwner([
        { text: "a", owner: "Ada" },
        { text: "b", owner: "Bob" },
        { text: "c", owner: "Ada" },
      ])
    ).toEqual([
      { owner: "Ada", items: ["a", "c"] },
      { owner: "Bob", items: ["b"] },
    ]);
  });

  it("merges owners that differ by case or surrounding whitespace and keeps the first spelling", () => {
    expect(
      groupActionItemsByOwner([
        { text: "a", owner: "Ada" },
        { text: "b", owner: " ada " },
        { text: "c", owner: "ADA" },
      ])
    ).toEqual([{ owner: "Ada", items: ["a", "b", "c"] }]);
  });

  it("puts null and blank owners in one trailing group", () => {
    expect(
      groupActionItemsByOwner([
        { text: "a", owner: null },
        { text: "b", owner: "Ada" },
        { text: "c", owner: "   " },
      ])
    ).toEqual([
      { owner: "Ada", items: ["b"] },
      { owner: null, items: ["a", "c"] },
    ]);
  });
});
