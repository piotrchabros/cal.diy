import { describe, expect, it } from "vitest";
import { pickAdHocDurationMinutes } from "./adHocDuration";

describe("pickAdHocDurationMinutes", () => {
  it("picks the smallest choice that covers the remaining time", () => {
    expect(pickAdHocDurationMinutes(50, 240)).toBe(60);
    expect(pickAdHocDurationMinutes(60, 240)).toBe(60);
    expect(pickAdHocDurationMinutes(61, 240)).toBe(90);
  });

  it("never goes below the smallest choice", () => {
    expect(pickAdHocDurationMinutes(3, 240)).toBe(15);
    expect(pickAdHocDurationMinutes(-10, 240)).toBe(15);
  });

  it("caps at the largest choice within the maximum", () => {
    expect(pickAdHocDurationMinutes(300, 240)).toBe(240);
    expect(pickAdHocDurationMinutes(200, 120)).toBe(120);
    expect(pickAdHocDurationMinutes(100, 100)).toBe(90);
  });

  it("falls back to the smallest choice when the maximum is below every choice", () => {
    expect(pickAdHocDurationMinutes(60, 10)).toBe(15);
    expect(pickAdHocDurationMinutes(60, 0)).toBe(15);
  });
});
