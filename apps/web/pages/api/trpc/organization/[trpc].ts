import { createNextApiHandler } from "@calcom/trpc/server/createNextApiHandler";
import { organizationRouter } from "@calcom/trpc/server/routers/viewer/organization/_router";

export default createNextApiHandler(organizationRouter);
