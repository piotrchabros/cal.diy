import { getCustomerAndCheckoutSession } from "@calcom/app-store/stripepayment/lib/getCustomerAndCheckoutSession";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { getSafeRedirectUrl } from "@calcom/lib/getSafeRedirectUrl";
import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { defaultHandler } from "@calcom/lib/server/defaultHandler";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { NextApiRequest, NextApiResponse } from "next";
import z from "zod";
import { getOAuthSafeRedirectOptions } from "../../_utils/oauth/getOAuthRedirectUri";
import { VerificationTokenService } from "../lib/VerificationTokenService";

const querySchema = z.object({
  callbackUrl: z.string(),
  checkoutSessionId: z.string(),
});

export type AssignPremiumUsername = (params: {
  userId: number;
  organizationId: number;
  username: string;
}) => Promise<void>;

export type SendVerificationRequest = (params: { identifier: string; url: string }) => Promise<void>;

// Resolves the domain the buyer checks out on. app-store must not import
// @calcom/features, so the apps/web caller injects OrganizationUrlService here;
// without it the default host is used (and OrganizationUrlService itself falls
// back to WEBAPP_URL while organizations are disabled).
export type GetPaymentCallbackBaseUrl = (params: {
  organizationId: number | null | undefined;
}) => Promise<string>;

export type PaymentCallbackDeps = {
  sendVerificationRequest: SendVerificationRequest;
  assignUsername?: AssignPremiumUsername;
  getBaseUrl?: GetPaymentCallbackBaseUrl;
};

async function getDefaultBaseUrl(): Promise<string> {
  return WEBAPP_URL;
}

async function assignUsernameDirectly({
  userId,
  username,
}: Parameters<AssignPremiumUsername>[0]): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { username },
    select: { id: true },
  });
}

// It handles premium user payment success/failure
export function createPaymentCallbackHandler({
  sendVerificationRequest,
  assignUsername = assignUsernameDirectly,
  getBaseUrl = getDefaultBaseUrl,
}: PaymentCallbackDeps) {
  async function getHandler(req: NextApiRequest, res: NextApiResponse) {
    const { callbackUrl: rawCallbackUrl, checkoutSessionId } = querySchema.parse(req.query);
    const log = logger.getSubLogger({
      prefix: [`[paymentCallback] checkoutSessionId: ${checkoutSessionId}`],
    });
    const { stripeCustomer, checkoutSession } = await getCustomerAndCheckoutSession(checkoutSessionId);

    if (!stripeCustomer) {
      log.error("Could not find stripeCustomer");
      throw new HttpError({
        statusCode: 404,
        message:
          "Stripe customer not found or deleted.  Please contact support@cal.com and mention your premium username",
        url: req.url,
        method: req.method,
      });
    }

    let user;

    if (stripeCustomer?.email) {
      user = await prisma.user.findFirst({
        where: {
          email: stripeCustomer.email,
        },
        select: {
          id: true,
          email: true,
          locale: true,
          metadata: true,
          organizationId: true,
        },
      });
    }

    // If we cannot find the user via email, query via stripeCustomerId
    if (!user) {
      user = await prisma.user.findFirst({
        where: {
          metadata: {
            path: ["stripeCustomerId"],
            equals: stripeCustomer.id,
          },
        },
        select: {
          id: true,
          email: true,
          locale: true,
          metadata: true,
          organizationId: true,
        },
      });
    }

    if (!user) {
      log.error("Could not find user");
      throw new HttpError({ statusCode: 404, message: "User not found", url: req.url, method: req.method });
    }

    const username = stripeCustomer.metadata.username;
    const email = user.email ?? stripeCustomer.email;

    // Stay on the purchasing user's organization domain: the session cookie the
    // magic link signs into belongs to that host, not the default WEBAPP_URL.
    const baseUrl = await getBaseUrl({ organizationId: user.organizationId });
    // An absolute callbackUrl is attacker-influenced (it round-trips through Stripe's
    // return_url), so only keep it on a trusted origin — the buyer's org domain or the
    // request host's org domain — and fail closed to the org base URL otherwise.
    // Relative URLs stay resolved against the org base, as before.
    const safeRedirectOptions = getOAuthSafeRedirectOptions(req);
    const callbackUrl =
      rawCallbackUrl.search(/^https?:\/\//) === -1
        ? new URL(rawCallbackUrl, baseUrl)
        : new URL(
            getSafeRedirectUrl(rawCallbackUrl, {
              allowedOrigins: [baseUrl, ...safeRedirectOptions.allowedOrigins],
              fallbackUrl: `${baseUrl}/`,
            }) ?? `${baseUrl}/`
          );

    // If payment hasn't been completed, redirect to verify page with failure status
    if (checkoutSession.payment_status !== "paid") {
      log.warn("Payment not completed", { paymentStatus: checkoutSession.payment_status });
      callbackUrl.searchParams.set("email", email || "");
      callbackUrl.searchParams.set("username", username || "");
      callbackUrl.searchParams.set("paymentStatus", checkoutSession.payment_status);
      return res.redirect(callbackUrl.toString()).end();
    }

    if (stripeCustomer.metadata.username) {
      try {
        await assignUsername({ userId: user.id, organizationId: user.organizationId, username });
        await prisma.user.update({
          where: { id: user.id },
          data: {
            metadata: {
              ...(user.metadata as Prisma.JsonObject),
              isPremium: true,
            },
          },
          select: { id: true },
        });
      } catch (error) {
        log.error(error);
        throw new HttpError({
          statusCode: 400,
          url: req.url,
          method: req.method,
          message:
            "We have received your payment. Your premium username could still not be reserved. Please contact support@cal.com and mention your premium username",
        });
      }
    }

    const expires = new Date(Date.now() + 86400 * 1000); // 1 day

    const token = await VerificationTokenService.create({ identifier: email, expires });

    // Generate the callback URL with token
    const params = new URLSearchParams({
      callbackUrl: baseUrl,
      token,
      email,
    });
    const url = `${baseUrl}/api/auth/callback/email?${params.toString()}`;

    await sendVerificationRequest({
      identifier: email,
      url,
    });

    // Pass email, username, and payment status in the redirect URL
    callbackUrl.searchParams.set("email", email || "");
    callbackUrl.searchParams.set("username", username);
    callbackUrl.searchParams.set("paymentStatus", checkoutSession.payment_status);

    return res.redirect(callbackUrl.toString()).end();
  }

  return defaultHandler({
    GET: Promise.resolve({ default: defaultResponder(getHandler) }),
  });
}
