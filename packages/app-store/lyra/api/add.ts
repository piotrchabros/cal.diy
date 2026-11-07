import { stringify } from "node:querystring";
import { defaultHandler } from "@calcom/lib/server/defaultHandler";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";
import prisma from "@calcom/prisma";
import type { NextApiRequest } from "next";
import { encodeOAuthState } from "../../_utils/oauth/encodeOAuthState";
import { getOAuthRedirectUri } from "../../_utils/oauth/getOAuthRedirectUri";
import { getLyraAppKeys, LYRA_API_URL } from "../lib";

async function handler(req: NextApiRequest) {
  await prisma.user.findFirstOrThrow({
    where: {
      id: req.session?.user?.id,
    },
    select: {
      id: true,
    },
  });

  const { client_id } = await getLyraAppKeys();
  const state = encodeOAuthState(req);

  const params = {
    response_type: "code",
    client_id,
    redirect_uri: getOAuthRedirectUri(req, "lyra"),
    scope: "meeting.create",
    state,
  };
  const query = stringify(params);
  const url = `${LYRA_API_URL}/oauth/authorize?${query}`;
  return { url };
}

export default defaultHandler({
  GET: Promise.resolve({ default: defaultResponder(handler) }),
});
