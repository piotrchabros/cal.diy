import type { NotetakerBotProviderDto } from "@calcom/lib/dto/NotetakerStateDto";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type {
  NotetakerBotEvent,
  NotetakerBotJoinRequest,
  NotetakerBotStateDto,
  NotetakerBotStopReason,
} from "@calcom/lib/notetaker/botContract";

export interface INotetakerBotGateway {
  /**
   * Rejects with an `ErrorWithCode` built by `createNotetakerBotGatewayError`:
   * `LINK_UNUSABLE` for HTTP 422 (except body `{ error: "invalid_request" }`, which is `TRANSIENT`:
   * the bot could not read the request, so the next sweep retries until the give-up deadline),
   * `TRANSIENT` for timeout, network error, 5xx or 503.
   */
  requestJoin(input: NotetakerBotJoinRequest): Promise<{ externalRef: string }>;
  /** Resolves, without throwing, on 404. */
  requestStop(input: { sessionId: string; reason: NotetakerBotStopReason }): Promise<void>;
  getState(sessionId: string): Promise<NotetakerBotStateDto | null>;
}

export type NotetakerBotEventSink = (event: NotetakerBotEvent) => Promise<void>;

export type NotetakerBotGatewayFailure = "LINK_UNUSABLE" | "TRANSIENT";

// ErrorCode has no 422 or 503 member, so the discriminator travels in `data`.
export function createNotetakerBotGatewayError(
  failure: NotetakerBotGatewayFailure,
  message: string
): ErrorWithCode {
  if (failure === "LINK_UNUSABLE") {
    return new ErrorWithCode(ErrorCode.BadRequest, message, { notetakerGatewayFailure: failure });
  }
  return new ErrorWithCode(ErrorCode.InternalServerError, message, { notetakerGatewayFailure: failure });
}

export function getNotetakerBotGatewayFailure(error: unknown): NotetakerBotGatewayFailure | null {
  if (!(error instanceof ErrorWithCode)) return null;
  const failure = error.data?.notetakerGatewayFailure;
  if (failure === "LINK_UNUSABLE") return "LINK_UNUSABLE";
  if (failure === "TRANSIENT") return "TRANSIENT";
  return null;
}

export type NotetakerBotGatewayBinding = {
  gateway: INotetakerBotGateway;
  provider: Extract<NotetakerBotProviderDto, "SELF_HOSTED" | "FAKE">;
};

export interface INotetakerBotGatewayResolver {
  /** Null means the provider is unusable; never throws. */
  resolve(): NotetakerBotGatewayBinding | null;
}
