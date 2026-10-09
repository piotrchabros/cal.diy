import { createNextApiHandler } from "@calcom/trpc/server/createNextApiHandler";
import { notetakerRouter } from "@calcom/trpc/server/routers/viewer/notetaker/_router";

export default createNextApiHandler(notetakerRouter);
