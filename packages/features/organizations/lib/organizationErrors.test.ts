import { describe, expect, it } from "vitest";
import en from "../../../i18n/locales/en/common.json";
import { ORGANIZATION_ERRORS } from "./organizationErrors";

describe("ORGANIZATION_ERRORS", () => {
  it.each(Object.entries(ORGANIZATION_ERRORS))("%s has an English translation", (_name, key) => {
    expect(en).toHaveProperty(key);
    expect((en as Record<string, string>)[key]).not.toBe("");
  });

  it("uses a distinct key for every error", () => {
    const keys = Object.values(ORGANIZATION_ERRORS);

    expect(new Set(keys).size).toBe(keys.length);
  });
});
