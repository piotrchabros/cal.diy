import type { ISimpleLogger } from "@calcom/features/di/shared/services/logger.service";
import type { AgentBrowserPageState } from "@calcom/lib/agentBrowser/contract";
import type {
  MeetingAgentBrowserActions,
  MeetingAgentBrowserCommand,
  MeetingAgentBrowserPage,
} from "../agent/IMeetingAgent";
import type { IRecallApiClient } from "../bot/recall/RecallApiClient";
import { getRecallApiErrorInfo } from "../bot/recall/RecallApiClient";
import { getAgentBrowserGatewayErrorInfo, type IAgentBrowserGateway } from "./IAgentBrowserGateway";

// The bot needs a few seconds to load the viewer page and connect; until then agent-browser still reports
// zero viewers, and a second share request would reload the page in the meeting.
const DEFAULT_SHARE_GRACE_MS = 20_000;

export interface IMeetingAgentBrowserServiceDeps {
  gateway: IAgentBrowserGateway;
  recallClient: IRecallApiClient;
  logger: ISimpleLogger;
}

function toPage(state: AgentBrowserPageState): MeetingAgentBrowserPage {
  return { url: state.url, title: state.title, snapshot: state.snapshot, screenshot: state.screenshot };
}

function getErrorKind(error: unknown): string {
  return getAgentBrowserGatewayErrorInfo(error)?.kind ?? getRecallApiErrorInfo(error)?.kind ?? "UNKNOWN";
}

export class MeetingAgentBrowserService {
  private readonly now: () => Date;
  private readonly shareGraceMs: number;
  // Kept in memory only: agent-browser's viewer count is the source of truth, this just bridges the grace window.
  private readonly shareRequestedAt = new Map<string, number>();

  constructor(
    private readonly deps: IMeetingAgentBrowserServiceDeps,
    options?: { now?: () => Date; shareGraceMs?: number }
  ) {
    this.now = options?.now ?? (() => new Date());
    this.shareGraceMs = options?.shareGraceMs ?? DEFAULT_SHARE_GRACE_MS;
  }

  forBot(botId: string): MeetingAgentBrowserActions {
    return {
      open: (url) => this.open(botId, url),
      perform: (command) => this.perform(botId, command),
      close: () => this.close(botId),
    };
  }

  async closeForBot(botId: string): Promise<void> {
    try {
      await this.close(botId);
    } catch (error) {
      this.deps.logger.warn("Failed to close the agent browser for a bot", {
        botId,
        kind: getErrorKind(error),
      });
    }
  }

  private async open(botId: string, url: string): Promise<MeetingAgentBrowserPage> {
    const state = await this.deps.gateway.perform(botId, { type: "goto", url });
    await this.ensureShared(botId, state.viewers);
    return toPage(state);
  }

  private async perform(
    botId: string,
    command: MeetingAgentBrowserCommand
  ): Promise<MeetingAgentBrowserPage> {
    return toPage(await this.deps.gateway.perform(botId, command));
  }

  private async ensureShared(botId: string, viewers: number): Promise<void> {
    if (viewers > 0) return;

    const nowMs = this.now().getTime();
    this.forgetExpiredShareRequests(nowMs);
    if (this.shareRequestedAt.has(botId)) return;

    // Recorded before the request so a concurrent open inside the grace window does not share twice.
    this.shareRequestedAt.set(botId, nowMs);
    try {
      await this.deps.recallClient.startScreenshare(
        botId,
        this.deps.gateway.buildViewerUrl(botId, new Date(nowMs))
      );
    } catch (error) {
      this.shareRequestedAt.delete(botId);
      throw error;
    }
  }

  private forgetExpiredShareRequests(nowMs: number): void {
    this.shareRequestedAt.forEach((requestedAt, botId) => {
      if (nowMs - requestedAt >= this.shareGraceMs) this.shareRequestedAt.delete(botId);
    });
  }

  private async close(botId: string): Promise<void> {
    const { gateway, recallClient, logger } = this.deps;
    this.shareRequestedAt.delete(botId);

    try {
      await recallClient.stopScreenshare(botId);
    } catch (error) {
      logger.warn("Failed to stop the agent browser screenshare", { botId, kind: getErrorKind(error) });
    }

    try {
      await gateway.closeSession(botId);
    } catch (error) {
      // agent-browser being down means the session is gone or will be reaped; only a real refusal is surfaced.
      if (getAgentBrowserGatewayErrorInfo(error)?.kind !== "UNAVAILABLE") throw error;
      logger.warn("Failed to close the agent browser session", { botId, kind: "UNAVAILABLE" });
    }
  }
}
