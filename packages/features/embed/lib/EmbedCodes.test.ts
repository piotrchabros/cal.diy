import { EMBED_LIB_URL } from "@calcom/lib/constants";
import { describe, expect, it, vi } from "vitest";
import type { PreviewState } from "../types";
import { buildEmbedSnippetString, Codes } from "./EmbedCodes";

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

// embed.js takes the booker origin from the snippet, not from its own script URL, so every
// organization keeps loading the library from EMBED_LIB_URL and only the origin changes.
describe("buildEmbedSnippetString", () => {
  const bookerUrl = "https://cal.bespokesoft.pl";

  it.each([
    "30min",
    null,
  ])("loads EMBED_LIB_URL and inits with the organization origin (namespace %s)", (namespace) => {
    const output = buildEmbedSnippetString({ namespace, bookerUrl, embedLibUrl: EMBED_LIB_URL });
    expect(output).toContain(`})(window, "${EMBED_LIB_URL}", "init");`);
    expect(output).toContain(`origin:"${bookerUrl}"`);
  });

  it("passes the namespace as the first init argument", () => {
    const output = buildEmbedSnippetString({ namespace: "30min", bookerUrl, embedLibUrl: EMBED_LIB_URL });
    expect(output).toContain(`Cal("init", "30min", {origin:"${bookerUrl}"});`);
  });

  it("omits the namespace argument without a namespace", () => {
    const output = buildEmbedSnippetString({ namespace: null, bookerUrl, embedLibUrl: EMBED_LIB_URL });
    expect(output).toContain(`Cal("init",  {origin:"${bookerUrl}"});`);
  });
});

describe("Codes.react when self-hosted", () => {
  it("emits embedJsUrl=EMBED_LIB_URL together with calOrigin=the organization origin", async () => {
    vi.resetModules();
    vi.doMock("@calcom/lib/constants", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@calcom/lib/constants")>()),
      IS_SELF_HOSTED: true,
    }));
    const { Codes: SelfHostedCodes } = await import("./EmbedCodes");
    const embedCalOrigin = "https://cal.bespokesoft.pl";

    const output = SelfHostedCodes.react.inline({
      ...commonArgs,
      embedCalOrigin,
      previewState: inlinePreviewState,
    });

    expect(output).toContain(`embedJsUrl="${EMBED_LIB_URL}"`);
    expect(output).toContain(`calOrigin="${embedCalOrigin}"`);
    expect(output).toContain(`"embedLibUrl":"${EMBED_LIB_URL}"`);
    vi.doUnmock("@calcom/lib/constants");
  });
});
