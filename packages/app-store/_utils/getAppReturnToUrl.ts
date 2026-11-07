import { WEBAPP_URL } from "@calcom/lib/constants";

// Org-domain users must return to the domain whose session cookie holds the OAuth state nonce,
// not the default WEBAPP_URL. returnTo is never rendered into the DOM, so SSR/client mismatch is harmless.
export function getAppReturnToUrl(path: string): string {
  const origin = typeof window === "undefined" ? WEBAPP_URL : window.location.origin;
  return `${origin}${path}`;
}
