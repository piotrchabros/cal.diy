import { getSafeRedirectUrl } from "@calcom/lib/getSafeRedirectUrl";
import jsforce from "@jsforce/jsforce-node";
import type { NextApiRequest, NextApiResponse } from "next";
import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";
import getInstalledAppPath from "../../_utils/getInstalledAppPath";
import createOAuthAppCredential from "../../_utils/oauth/createOAuthAppCredential";
import { decodeOAuthState } from "../../_utils/oauth/decodeOAuthState";
import { getOAuthRedirectUri, getOAuthSafeRedirectOptions } from "../../_utils/oauth/getOAuthRedirectUri";
import appConfig from "../config.json";
import { getSalesforceTokenLifetime } from "../lib/getSalesforceTokenLifetime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { code } = req.query;
  const state = decodeOAuthState(req);

  if (code === undefined && typeof code !== "string") {
    res.status(400).json({ message: "`code` must be a string" });
    return;
  }

  if (!req.session?.user?.id) {
    return res.status(401).json({ message: "You must be logged in to do this" });
  }

  let consumerKey = "";
  let consumerSecret = "";
  const appKeys = await getAppKeysFromSlug("salesforce");
  if (typeof appKeys.consumer_key === "string") consumerKey = appKeys.consumer_key;
  if (typeof appKeys.consumer_secret === "string") consumerSecret = appKeys.consumer_secret;
  if (!consumerKey) return res.status(400).json({ message: "Salesforce consumer key missing." });
  if (!consumerSecret) return res.status(400).json({ message: "Salesforce consumer secret missing." });

  const conn = new jsforce.Connection({
    oauth2: {
      clientId: consumerKey,
      clientSecret: consumerSecret,
      redirectUri: getOAuthRedirectUri(req, "salesforce"),
    },
  });

  const salesforceTokenInfo = await conn.oauth2.requestToken(code as string);

  // Get token lifetime via introspection
  const tokenLifetime = await getSalesforceTokenLifetime({
    accessToken: salesforceTokenInfo.access_token,
    instanceUrl: salesforceTokenInfo.instance_url,
  });

  // Store token with token_lifetime
  await createOAuthAppCredential(
    { appId: appConfig.slug, type: appConfig.type },
    { ...salesforceTokenInfo, token_lifetime: tokenLifetime },
    req
  );

  res.redirect(
    getSafeRedirectUrl(state?.returnTo, getOAuthSafeRedirectOptions(req)) ??
      getInstalledAppPath({ variant: "other", slug: "salesforce" })
  );
}
