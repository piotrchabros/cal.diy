// preview.ts is compiled by Vite into a standalone Vanilla JS page and can't import @calcom/lib,
// so these guards take every origin as a parameter instead of reading env vars.
// The app serves preview.html on every organization domain (FR-014), so a parent page or resource on
// the page's own origin is the app itself and is trusted even when its TLD+1 differs from WEBAPP_URL.

function toOrigin(urlString: string): string | null {
  try {
    const { origin } = new URL(urlString);
    // Opaque origins serialize to "null"; never let one match anything.
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export type PreviewOrigins = { webappUrl: string; embedLibUrl: string; currentOrigin: string };

export function isAllowedPreviewReferrer(
  referrer: string,
  origins: Pick<PreviewOrigins, "webappUrl" | "currentOrigin">
): boolean {
  if (!referrer) {
    return false;
  }
  if (origins.webappUrl && referrer.startsWith(origins.webappUrl)) {
    return true;
  }
  const referrerOrigin = toOrigin(referrer);
  return referrerOrigin !== null && referrerOrigin === origins.currentOrigin;
}

// The only copy of these TLD+1 rules: the embed preview cannot import from @calcom/lib, so they live here
export function isSafeUrlToLoadResourceFrom(urlString: string, origins: PreviewOrigins): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    // Allow localhost for development
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return true;
    }

    if (url.origin === origins.currentOrigin) {
      return true;
    }

    const webappUrl = new URL(origins.webappUrl);
    const embedLibUrl = new URL(origins.embedLibUrl);

    const urlTldPlus1 = getTldPlus1(url.hostname);
    const webappTldPlus1 = getTldPlus1(webappUrl.hostname);
    const embedLibTldPlus1 = getTldPlus1(embedLibUrl.hostname);

    // URLs must share the same TLD+1
    return [webappTldPlus1, embedLibTldPlus1].includes(urlTldPlus1);
  } catch {
    return false;
  }

  function getTldPlus1(hostname: string) {
    // Note: It doesn't support multipart tlds like .co.uk and thus makes only one part tld's safe like .com(and thus cal.com)
    // If we want to use it elsewhere as well(apart from embed/preview.ts) we must consider Public Suffix List
    return hostname.split(".").slice(-2).join(".");
  }
}
