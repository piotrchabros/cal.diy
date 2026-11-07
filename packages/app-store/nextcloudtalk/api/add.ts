import { stringify } from "node:querystring";
import { defaultHandler } from "@calcom/lib/server/defaultHandler";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";
import type { NextApiRequest } from "next";
import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";
import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import { getOAuthRedirectUri } from "../../_utils/oauth/getOAuthRedirectUri";

async function handler(req: NextApiRequest) {
  const user = req?.session?.user;
  if (!user) {
    return { status: 401, body: { error: "Unauthorized" } };
  }

  const appKeys = await getAppKeysFromSlug("nextcloudtalk");
  const hostUrl = appKeys.nextcloudTalkHost as string;
  const client_id = appKeys.nextcloudTalkClientId as string;
  const client_secret = appKeys.nextcloudTalkClientSecret as string;
  const state = encodeOAuthState(req);

  const params = {
    response_type: "code",
    client_id,
    client_secret,
    redirect_uri: getOAuthRedirectUri(req, "nextcloudtalk"),
    state,
  };
  const query = stringify(params);
  const url = `${hostUrl}/index.php/apps/oauth2/authorize?${query}`;
  return { url };
}

export default defaultHandler({
  GET: Promise.resolve({ default: defaultResponder(handler) }),
});
