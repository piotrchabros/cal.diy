import { stringify } from "node:querystring";
import { defaultHandler } from "@calcom/lib/server/defaultHandler";
import { defaultResponder } from "@calcom/lib/server/defaultResponder";
import prisma from "@calcom/prisma";
import type { NextApiRequest } from "next";
import { getOAuthRedirectUri } from "../../_utils/oauth/getOAuthRedirectUri";
import { getBasecampKeys } from "../lib/getBasecampKeys";

async function handler(req: NextApiRequest) {
  await prisma.user.findFirstOrThrow({
    where: {
      id: req.session?.user?.id,
    },
    select: {
      id: true,
    },
  });

  const { client_id } = await getBasecampKeys();

  const params = {
    type: "web_server",
    client_id,
  };
  const query = stringify(params);
  const url = `https://launchpad.37signals.com/authorization/new?${query}&redirect_uri=${getOAuthRedirectUri(req, "basecamp3")}`;
  return { url };
}

export default defaultHandler({
  GET: Promise.resolve({ default: defaultResponder(handler) }),
});
