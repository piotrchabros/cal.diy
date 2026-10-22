import type { NotetakerSessionStatusDto } from "@calcom/lib/dto/NotetakerStateDto";
import { describe, expect, it } from "vitest";
import { isNotetakerVideoDownloadable } from "./videoAvailability";

type SessionInput = Parameters<typeof isNotetakerVideoDownloadable>[0];

function session(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    botProvider: "RECALL",
    externalRef: "bot-1",
    status: "READY",
    resultsDeletedAt: null,
    ...overrides,
  };
}

describe("isNotetakerVideoDownloadable", () => {
  it.each<NotetakerSessionStatusDto>([
    "READY",
    "ENDED_EARLY",
  ])("allows a finished %s Recall session", (status) => {
    expect(isNotetakerVideoDownloadable(session({ status }))).toBe(true);
  });

  it.each<NotetakerSessionStatusDto>([
    "SCHEDULED",
    "WAITING_TO_BE_ADMITTED",
    "TRANSCRIBING",
    "PROCESSING",
    "FAILED",
  ])("refuses a %s session", (status) => {
    expect(isNotetakerVideoDownloadable(session({ status }))).toBe(false);
  });

  it.each(["FAKE", "SELF_HOSTED"] as const)("refuses the %s provider", (botProvider) => {
    expect(isNotetakerVideoDownloadable(session({ botProvider }))).toBe(false);
  });

  it.each([null, ""])("refuses a session without an external reference (%j)", (externalRef) => {
    expect(isNotetakerVideoDownloadable(session({ externalRef }))).toBe(false);
  });

  it("refuses a session whose results were deleted", () => {
    expect(
      isNotetakerVideoDownloadable(session({ resultsDeletedAt: new Date("2026-10-13T08:00:00.000Z") }))
    ).toBe(false);
  });
});
