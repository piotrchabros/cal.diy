import { createNextApiHandler } from "@calcom/trpc/server/createNextApiHandler";
import { organizationRouter } from "@calcom/trpc/server/routers/viewer/organization/_router";

export default createNextApiHandler(organizationRouter);

// The logo arrives as a base64 data URL, which exceeds the 1mb default body limit
export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };
