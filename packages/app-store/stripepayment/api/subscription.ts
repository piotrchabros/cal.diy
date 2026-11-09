import { getPremiumMonthlyPlanPriceId } from "@calcom/app-store/stripepayment/lib/utils";
import { usernameCheck } from "@calcom/lib/server/username";
import prisma from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { NextApiRequest, NextApiResponse } from "next";
import type Stripe from "stripe";
import { getOAuthAppOrigin } from "../../_utils/oauth/getOAuthRedirectUri";
import { getStripeCustomerIdFromUserId } from "../lib/customer";
import stripe from "../lib/server";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    // The apps/web integrations catch-all ([...args].ts) already resolves the session onto req, and app-store must not import features.
    const session = req.session;
    const userId = session?.user?.id;
    let { intentUsername = null } = req.query;
    const { callbackUrl } = req.query;
    if (!userId || !intentUsername) {
      res.status(404).json({ message: "Missing required parameters: userId or intentUsername" });
      return;
    }
    if (intentUsername && typeof intentUsername === "object") {
      intentUsername = intentUsername[0];
    }
    const customerId = await getStripeCustomerIdFromUserId(userId);
    if (!customerId) {
      res.status(404).json({ message: "Missing customer id" });
      return;
    }

    const userData = await prisma.user.findFirst({
      where: { id: userId },
      select: { id: true, metadata: true },
    });
    if (!userData) {
      res.status(404).json({ message: "Missing user data" });
      return;
    }

    // Stay on the domain the buyer started checkout from: Stripe redirects the
    // browser back here, and the session cookie belongs to that domain.
    // Encode the callback URL so an absolute value carrying its own query string
    // survives as a single return_url param (Next.js decodes req.query, so
    // paymentCallback sees the original). The {CHECKOUT_SESSION_ID} placeholder
    // must stay literal for Stripe to substitute it.
    const rawCallbackUrl = Array.isArray(callbackUrl) ? (callbackUrl[0] ?? "") : (callbackUrl ?? "");
    const return_url = `${getOAuthAppOrigin(
      req
    )}/api/integrations/stripepayment/paymentCallback?checkoutSessionId={CHECKOUT_SESSION_ID}&callbackUrl=${encodeURIComponent(
      rawCallbackUrl
    )}`;
    const createSessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [
        {
          quantity: 1,
          price: getPremiumMonthlyPlanPriceId(),
        },
      ],
      allow_promotion_codes: true,
      customer: customerId,
      success_url: return_url,
      cancel_url: return_url,
      metadata: {
        userId: userId.toString(),
        intentUsername,
      },
    };

    const checkPremiumResult = await usernameCheck(intentUsername);
    if (!checkPremiumResult.available) {
      return res.status(404).json({ message: "Intent username not available" });
    }
    const stripeCustomer = await stripe.customers.retrieve(customerId);
    if (!stripeCustomer || stripeCustomer.deleted) {
      return res.status(400).json({ message: "Stripe customer not found or deleted" });
    }
    await stripe.customers.update(customerId, {
      metadata: {
        ...stripeCustomer.metadata,
        username: intentUsername,
      },
    });

    if (userData) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          metadata: {
            ...((userData.metadata as Prisma.JsonObject) || {}),
            isPremium: false,
          },
        },
      });
    }
    const checkoutSession = await stripe.checkout.sessions.create(createSessionParams);
    if (checkoutSession?.url) {
      return res.redirect(checkoutSession.url).end();
    }
    return res.status(404).json({ message: "Couldn't redirect to stripe checkout session" });
  }
}
