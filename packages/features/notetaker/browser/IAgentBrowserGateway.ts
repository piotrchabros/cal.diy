import type {
  AgentBrowserAction,
  AgentBrowserErrorCode,
  AgentBrowserPageState,
} from "@calcom/lib/agentBrowser/contract";
import { AGENT_BROWSER_ERROR_CODES } from "@calcom/lib/agentBrowser/contract";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";

// UNAVAILABLE covers everything agent-browser did not answer itself: network errors, timeouts, bad responses.
export type AgentBrowserGatewayErrorKind = AgentBrowserErrorCode | "UNAVAILABLE";

const GATEWAY_ERROR_KINDS: ReadonlySet<string> = new Set<string>([
  ...AGENT_BROWSER_ERROR_CODES,
  "UNAVAILABLE",
]);

function isGatewayErrorKind(value: unknown): value is AgentBrowserGatewayErrorKind {
  return typeof value === "string" && GATEWAY_ERROR_KINDS.has(value);
}

function errorCodeForKind(kind: AgentBrowserGatewayErrorKind): ErrorCode {
  switch (kind) {
    case "INVALID_INPUT":
    case "BLOCKED_URL":
      return ErrorCode.BadRequest;
    case "SESSION_NOT_FOUND":
      return ErrorCode.NotFound;
    case "STALE_REF":
      return ErrorCode.Conflict;
    default:
      return ErrorCode.InternalServerError;
  }
}

// ErrorCode has no member per agent-browser error, so the discriminator travels in `data`.
export function createAgentBrowserGatewayError(
  kind: AgentBrowserGatewayErrorKind,
  message: string
): ErrorWithCode {
  return new ErrorWithCode(errorCodeForKind(kind), message, { agentBrowserErrorKind: kind });
}

export function getAgentBrowserGatewayErrorInfo(
  error: unknown
): { kind: AgentBrowserGatewayErrorKind } | null {
  if (!(error instanceof ErrorWithCode)) return null;
  const kind = error.data?.agentBrowserErrorKind;
  if (!isGatewayErrorKind(kind)) return null;
  return { kind };
}

export interface IAgentBrowserGateway {
  perform(botId: string, action: AgentBrowserAction): Promise<AgentBrowserPageState>;
  /** Idempotent; UNAVAILABLE on a network failure. */
  closeSession(botId: string): Promise<void>;
  /** The URL Recall's Output Media page loads; it carries a viewer token bound to the bot. */
  buildViewerUrl(botId: string, now: Date): string;
}
