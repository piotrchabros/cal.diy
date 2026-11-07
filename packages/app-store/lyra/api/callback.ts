import { getSafeRedirectUrl } from "@calcom/lib/getSafeRedirectUrl";
import prisma from "@calcom/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import getInstalledAppPath from "../../_utils/getInstalledAppPath";
import createOAuthAppCredential from "../../_utils/oauth/createOAuthAppCredential";
import { decodeOAuthState } from "../../_utils/oauth/decodeOAuthState";
import { getOAuthRedirectUri, getOAuthSafeRedirectOptions } from "../../_utils/oauth/getOAuthRedirectUri";
import { getLyraAppKeys, LYRA_API_URL } from "../lib";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const state = decodeOAuthState(req);
  const safeRedirectOptions = getOAuthSafeRedirectOptions(req);

  // Handle user denial or other OAuth errors gracefully
  if (req.query.error) {
    const errorReturnTo =
      getSafeRedirectUrl(state?.onErrorReturnTo, safeRedirectOptions) ?? "/apps/installed/conferencing";
    res.redirect(errorReturnTo);
    return;
  }

  const userId = req.session?.user.id;
  if (!userId) {
    return res.status(404).json({ message: "No user found" });
  }

  const { code } = req.query;
  const { client_id, client_secret } = await getLyraAppKeys();

  const redirectUri = getOAuthRedirectUri(req, "lyra");

  // Exchange authorization code for access token
  const result = await fetch(`${LYRA_API_URL}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id,
      client_secret,
      redirect_uri: redirectUri,
    }),
  });

  if (result.status !== 200) {
    let errorMessage = "Something went wrong with the Lyra OAuth flow";
    try {
      const responseBody = await result.json();
      errorMessage = responseBody.error || errorMessage;
    } catch (_e) {
      errorMessage = await result.clone().text();
    }

    res.status(400).json({ message: errorMessage });
    return;
  }

  const responseBody = await result.json();

  if (responseBody.error) {
    res.status(400).json({ message: responseBody.error });
    return;
  }

  // Convert expires_in (seconds) to expiry_date (absolute ms timestamp)
  // This follows Cal.diy's universal OAuth token schema
  responseBody.expiry_date = Math.round(Date.now() + responseBody.expires_in * 1000);
  delete responseBody.expires_in;

  // Remove any existing lyra_video credentials for this user to avoid duplicates
  await prisma.credential.deleteMany({
    where: { type: "lyra_video", userId, appId: "lyra" },
  });

  await createOAuthAppCredential({ appId: "lyra", type: "lyra_video" }, responseBody, req);

  res.redirect(
    getSafeRedirectUrl(state?.returnTo, safeRedirectOptions) ??
      getInstalledAppPath({ variant: "conferencing", slug: "lyra" })
  );
}
