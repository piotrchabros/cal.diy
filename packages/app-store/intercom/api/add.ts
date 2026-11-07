import { stringify } from "node:querystring";
import type { NextApiRequest, NextApiResponse } from "next";
import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";
import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import { getOAuthRedirectUri } from "../../_utils/oauth/getOAuthRedirectUri";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    let clientId = "";
    const appKeys = await getAppKeysFromSlug("intercom");
    if (typeof appKeys.client_id === "string") clientId = appKeys.client_id;
    if (!clientId) return res.status(400).json({ message: "Intercom client_id missing." });

    const state = encodeOAuthState(req);

    const params = {
      client_id: clientId,
      redirect_uri: getOAuthRedirectUri(req, "intercom"),
      state,
      response_type: "code",
    };

    const authUrl = `https://app.intercom.com/oauth?${stringify(params)}`;

    res.status(200).json({ url: authUrl });
  }
}
