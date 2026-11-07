import slugify from "@calcom/lib/slugify";
import { describe, expect, it } from "vitest";
import { usernameSlug } from "./usernameSlug";

const SUFFIX = "[a-z0-9]{6}";

describe("usernameSlug", () => {
  it("appends a dash and six lowercase alphanumerics to the slugified base", () => {
    expect(usernameSlug("john")).toMatch(new RegExp(`^john-${SUFFIX}$`));
  });

  it.each([null, undefined, "", "+++", "!@#"])("falls back to 'user' for base %j", (base) => {
    expect(usernameSlug(base)).toMatch(new RegExp(`^user-${SUFFIX}$`));
  });

  it.each(["John.Doe+x", "Jane Smith", "UPPER_case"])("slugifies %j before adding the suffix", (base) => {
    const slug = slugify(base);
    expect(slug).not.toBe("");
    const result = usernameSlug(base);
    expect(result).toMatch(new RegExp(`^${slug.replace(/\./g, "\\.")}-${SUFFIX}$`));
    expect(result).toBe(result.toLowerCase());
    expect(result).not.toMatch(/[+ ]/);
  });

  it("produces different suffixes across calls", () => {
    const results = new Set(Array.from({ length: 20 }, () => usernameSlug("john")));
    expect(results.size).toBeGreaterThan(1);
  });
});
