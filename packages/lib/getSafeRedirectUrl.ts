import { CONSOLE_URL, WEBAPP_URL, WEBSITE_URL } from "@calcom/lib/constants";

function toOrigin(url: string): string | null {
  try {
    const { origin } = new URL(url);
    // Opaque origins serialize to "null"; never let one match anything.
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export type SafeRedirectOptions = { allowedOrigins?: readonly string[]; fallbackUrl?: string };

// It ensures that redirection URL safe where it is accepted through a query params or other means where user can change it.
export const getSafeRedirectUrl = (
  url = "",
  { allowedOrigins = [], fallbackUrl = `${WEBAPP_URL}/` }: SafeRedirectOptions = {}
) => {
  if (!url) {
    return null;
  }

  //It is important that this fn is given absolute URL because urls that don't start with HTTP can still deceive browser into redirecting to another domain
  if (url.search(/^https?:\/\//) === -1) {
    throw new Error("Pass an absolute URL");
  }

  const urlParsed = new URL(url);

  // Avoid open redirection security vulnerability
  if (
    ![CONSOLE_URL, WEBAPP_URL, WEBSITE_URL].some((u) => new URL(u).origin === urlParsed.origin) &&
    !allowedOrigins.some((u) => toOrigin(u) === urlParsed.origin)
  ) {
    url = fallbackUrl;
  }

  return url;
};
