import { describe, expect, it, vi } from "vitest";
import type { PreviewState } from "../types";
import { Codes } from "./EmbedCodes";

vi.mock("@calcom/lib/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
  IS_SELF_HOSTED: false,
  WEBAPP_URL: "https://cal.example.com",
  WEBSITE_URL: "https://cal.example.com",
}));

const commonArgs = {
  calLink: "acme/30min",
  uiInstructionCode: "",
  namespace: "30min",
};

const inlinePreviewState = { width: "100%", height: "100%", config: {} } as PreviewState["inline"];
const floatingPopupPreviewState = { config: {} } as PreviewState["floatingPopup"];
const elementClickPreviewState = { config: {} } as PreviewState["elementClick"];

describe("Codes.react", () => {
  describe.each([
    "https://cal.example.com",
    "https://cal.bespokesoft.pl",
  ])("with embedCalOrigin %s", (embedCalOrigin) => {
    it("emits calOrigin prop for the inline embed", () => {
      const output = Codes.react.inline({
        ...commonArgs,
        embedCalOrigin,
        previewState: inlinePreviewState,
      });
      expect(output).toContain(`calOrigin="${embedCalOrigin}"`);
    });

    it("emits calOrigin in the floating-popup config", () => {
      const output = Codes.react["floating-popup"]({
        ...commonArgs,
        embedCalOrigin,
        previewState: floatingPopupPreviewState,
      });
      expect(output).toContain(`"calOrigin":"${embedCalOrigin}"`);
    });

    it("emits data-cal-origin for the element-click embed", () => {
      const output = Codes.react["element-click"]({
        ...commonArgs,
        embedCalOrigin,
        previewState: elementClickPreviewState,
      });
      expect(output).toContain(`data-cal-origin="${embedCalOrigin}"`);
    });
  });
});
