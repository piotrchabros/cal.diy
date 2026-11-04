import { describe, expect, it } from "vitest";
import { validateContactEmailInput } from "./contactEmailInput";

describe("validateContactEmailInput", () => {
  it("accepts an empty input", () => {
    expect(validateContactEmailInput("  ")).toEqual({ emails: [], error: null });
  });

  it("splits on commas and newlines, lowercases and dedupes", () => {
    expect(validateContactEmailInput("A@x.com, b@x.com\na@X.com;c@x.com")).toEqual({
      emails: ["a@x.com", "b@x.com", "c@x.com"],
      error: null,
    });
  });

  it("flags an invalid email", () => {
    expect(validateContactEmailInput("a@x.com, nope").error).toBe("INVALID");
  });

  it("flags more than 20 emails", () => {
    const emails = Array.from({ length: 21 }, (_, index) => `p${index}@x.com`).join(",");
    expect(validateContactEmailInput(emails).error).toBe("TOO_MANY");
  });
});
