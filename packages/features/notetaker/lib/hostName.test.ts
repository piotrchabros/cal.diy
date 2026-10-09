import { APP_NAME } from "@calcom/lib/constants";
import { describe, expect, it } from "vitest";
import { getNotetakerHostName } from "./hostName";

describe("getNotetakerHostName", () => {
  it("returns the organizer name", () => {
    expect(getNotetakerHostName({ name: "Ada Lovelace" })).toBe("Ada Lovelace");
  });

  it("trims the organizer name", () => {
    expect(getNotetakerHostName({ name: "  Ada Lovelace  " })).toBe("Ada Lovelace");
  });

  it("falls back to APP_NAME when the name is empty", () => {
    expect(getNotetakerHostName({ name: "" })).toBe(APP_NAME);
  });

  it("falls back to APP_NAME when the name is only whitespace", () => {
    expect(getNotetakerHostName({ name: "   " })).toBe(APP_NAME);
  });

  it("falls back to APP_NAME when the name is null", () => {
    expect(getNotetakerHostName({ name: null })).toBe(APP_NAME);
  });

  it("falls back to APP_NAME when the organizer is null", () => {
    expect(getNotetakerHostName(null)).toBe(APP_NAME);
  });
});
