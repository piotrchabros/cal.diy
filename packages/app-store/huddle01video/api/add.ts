import { stringify } from "node:querystring";
import { defaultHandler } from "@calcom/lib/server/defaultHandler";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";
import type { NextApiRequest } from "next";
import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import { getOAuthRedirectUri } from "../../_utils/oauth/getOAuthRedirectUri";

async function handler(req: NextApiRequest) {
  const state = encodeOAuthState(req);

  const params = {
    response_type: "code",
    redirect_uri: getOAuthRedirectUri(req, "huddle01video"),
    state,
    appName: "Calcom",
  };
  const query = stringify(params);

  const url = `https://huddle01.app/thirdparty_auth?${query}`;

  return { url };
}

export default defaultHandler({
  GET: Promise.resolve({ default: defaultResponder(handler) }),
});
