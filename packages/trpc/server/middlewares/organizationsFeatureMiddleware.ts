import { ErrorWithCode } from "@calcom/lib/errors";
import { isOrganizationsEnabled } from "@calcom/lib/organizations/isOrganizationsEnabled";
import { experimental_standaloneMiddleware, TRPCError } from "@trpc/server";
import { convertErrorWithCodeToTRPCError } from "../lib/toTRPCError";

// Standalone rather than the shared `middleware` helper: that one is typed to the root context, so authed
// procedures (which extend it with user/session) reject it
export const organizationsFeatureMiddleware = experimental_standaloneMiddleware<{ ctx: object }>().create(
  async ({ next }) => {
    // Keeps the API dark while ORGANIZATIONS_ENABLED is off in production, so the feature can ship unannounced
    if (!isOrganizationsEnabled()) throw new TRPCError({ code: "NOT_FOUND" });
    const result = await next();
    // tRPC v11 hands resolver errors back as a failed result instead of throwing, so the shared
    // errorConversionMiddleware never sees them; without this, service errors surface as 500s
    if (!result.ok && result.error.cause instanceof ErrorWithCode) {
      throw convertErrorWithCodeToTRPCError(result.error.cause);
    }
    return result;
  }
);
