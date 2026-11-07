import { stringify } from "node:querystring";
import prisma from "@calcom/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";
import { getOAuthRedirectUri } from "../../_utils/oauth/getOAuthRedirectUri";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    // Get user
    await prisma.user.findFirstOrThrow({
      where: {
        id: req.session?.user?.id,
      },
      select: {
        id: true,
      },
    });

    let clientId = "";
    let baseUrl = "";
    const appKeys = await getAppKeysFromSlug("tandem");
    if (typeof appKeys.client_id === "string") clientId = appKeys.client_id;
    if (typeof appKeys.base_url === "string") baseUrl = appKeys.base_url;
    if (!clientId) return res.status(400).json({ message: "Tandem client_id missing." });
    if (!baseUrl) return res.status(400).json({ message: "Tandem base_url missing." });

    const redirect_uri = encodeURI(getOAuthRedirectUri(req, "tandemvideo"));

    const params = {
      client_id: clientId,
      redirect_uri,
    };
    const query = stringify(params);
    const url = `${baseUrl}/oauth/approval?${query}`;
    res.status(200).json({ url });
  }
}
