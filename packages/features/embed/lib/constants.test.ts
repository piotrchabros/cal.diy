import { EMBED_LIB_URL, WEBAPP_URL } from "@calcom/lib/constants";
import { describe, expect, it } from "vitest";
import { buildEmbedPreviewIframeSrc, getEmbedPreviewHtmlUrl } from "./constants";

const ORG_BASE_URL = "https://cal.bespokesoft.pl";

describe("getEmbedPreviewHtmlUrl", () => {
  it("serves preview.html from the given base URL", () => {
    expect(getEmbedPreviewHtmlUrl(ORG_BASE_URL)).toBe(`${ORG_BASE_URL}/embed/preview.html`);
  });
});

describe("buildEmbedPreviewIframeSrc", () => {
  it("keeps the historical URL on the default WEBAPP_URL base", () => {
    expect(
      buildEmbedPreviewIframeSrc({
        baseUrl: WEBAPP_URL,
        embedType: "inline",
        calLink: "pro/30min",
        embedLibUrl: EMBED_LIB_URL,
      })
    ).toBe(
      `${WEBAPP_URL}/embed/preview.html?embedType=inline&calLink=pro/30min&embedLibUrl=${EMBED_LIB_URL}&bookerUrl=${WEBAPP_URL}`
    );
  });

  it("serves the preview and booker from the organization base URL", () => {
    expect(
      buildEmbedPreviewIframeSrc({
        baseUrl: ORG_BASE_URL,
        embedType: "floating-popup",
        calLink: "team/sales",
        embedLibUrl: EMBED_LIB_URL,
      })
    ).toBe(
      `${ORG_BASE_URL}/embed/preview.html?embedType=floating-popup&calLink=team/sales&embedLibUrl=${EMBED_LIB_URL}&bookerUrl=${ORG_BASE_URL}`
    );
  });
});
