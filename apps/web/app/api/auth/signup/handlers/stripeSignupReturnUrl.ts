import { getOAuthAppOrigin } from "@calcom/app-store/_utils/oauth/getOAuthRedirectUri";

/** Stripe substitutes this placeholder in success_url/cancel_url when redirecting back. */
export const STRIPE_CHECKOUT_SESSION_ID_PLACEHOLDER = "{CHECKOUT_SESSION_ID}";

/** Signup's post-payment landing path; the session id is filled in by Stripe. */
export const STRIPE_SIGNUP_CALLBACK_PATH = `/auth/verify?sessionId=${STRIPE_CHECKOUT_SESSION_ID_PLACEHOLDER}`;

/**
 * Encode a callback value for the Stripe return_url query param while keeping
 * Stripe's {CHECKOUT_SESSION_ID} placeholder literal so substitution still works.
 */
export function encodeStripeSignupCallbackUrl(callbackUrl: string): string {
  return encodeURIComponent(callbackUrl).replaceAll(
    encodeURIComponent(STRIPE_CHECKOUT_SESSION_ID_PLACEHOLDER),
    STRIPE_CHECKOUT_SESSION_ID_PLACEHOLDER
  );
}

export function buildStripeSignupReturnUrl(
  baseUrl: string,
  callbackUrl: string = STRIPE_SIGNUP_CALLBACK_PATH
): string {
  return `${baseUrl}/api/integrations/stripepayment/paymentCallback?checkoutSessionId=${STRIPE_CHECKOUT_SESSION_ID_PLACEHOLDER}&callbackUrl=${encodeStripeSignupCallbackUrl(
    callbackUrl
  )}`;
}

/**
 * Stay on the domain the buyer started checkout from (same pattern as the
 * stripepayment subscription return URL): the organization origin when the
 * request arrives on a known org host, WEBAPP_URL otherwise — and always
 * WEBAPP_URL while organizations are disabled.
 */
export function resolveStripeSignupBaseUrl(host: string | null | undefined): string {
  return getOAuthAppOrigin({ headers: { host: host ?? undefined } });
}
