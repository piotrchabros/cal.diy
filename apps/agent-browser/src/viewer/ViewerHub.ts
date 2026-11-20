import type { AgentBrowserViewerMessage } from "@calcom/lib/agentBrowser/contract";
import { AGENT_BROWSER_VIEWPORT } from "@calcom/lib/agentBrowser/contract";
import { WebSocket } from "ws";
import type { Logger } from "../logger";
import type { PageInfo } from "../sessions/IBrowserDriver";

type ViewerState = "waiting" | "live" | "closed" | "restarted";

// The part of a `ws` WebSocket the hub uses, so tests can pass a plain object.
type ViewerSocket = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  once(event: "close", listener: () => void): unknown;
};

type Channel = {
  viewers: Set<ViewerSocket>;
  state: ViewerState;
  lastFrame: Buffer | null;
  lastPage: PageInfo | null;
};

const DEFAULT_MAX_VIEWERS_PER_BOT = 3;
const DEFAULT_MAX_VIEWERS = 50;
// A viewer on a slow link would otherwise queue every frame in memory; dropping frames for it
// keeps the server bounded and the picture only ever lags by what is already buffered.
const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const NORMAL_CLOSURE = 1000;

class ViewerHub {
  private readonly channels = new Map<string, Channel>();
  private readonly logger: Logger;
  private readonly maxViewersPerBot: number;
  private readonly maxViewers: number;
  private readonly maxBufferedBytes: number;

  constructor(deps: {
    logger: Logger;
    maxViewersPerBot?: number;
    maxViewers?: number;
    maxBufferedBytes?: number;
  }) {
    this.logger = deps.logger;
    this.maxViewersPerBot = deps.maxViewersPerBot ?? DEFAULT_MAX_VIEWERS_PER_BOT;
    this.maxViewers = deps.maxViewers ?? DEFAULT_MAX_VIEWERS;
    this.maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  // Returns false when a cap is reached; the caller rejects the viewer before upgrading if it can.
  add(botId: string, ws: ViewerSocket): boolean {
    if (this.count(botId) >= this.maxViewersPerBot || this.total() >= this.maxViewers) return false;

    const channel = this.channels.get(botId) ?? this.createChannel(botId, "waiting");
    channel.viewers.add(ws);
    ws.once("close", () => this.remove(botId, ws));

    this.send(ws, {
      t: "hello",
      width: AGENT_BROWSER_VIEWPORT.width,
      height: AGENT_BROWSER_VIEWPORT.height,
      state: channel.state === "live" ? "live" : "waiting",
    });
    // A new viewer would otherwise stay blank until the page next repaints, which can take long on a static page.
    if (channel.lastPage) this.send(ws, { t: "page", ...channel.lastPage });
    if (channel.lastFrame) this.sendFrame(ws, channel.lastFrame);

    this.logger.debug("viewer joined", { botId, viewers: channel.viewers.size });
    return true;
  }

  count(botId: string): number {
    return this.channels.get(botId)?.viewers.size ?? 0;
  }

  total(): number {
    let total = 0;
    for (const channel of this.channels.values()) total += channel.viewers.size;
    return total;
  }

  broadcastFrame(botId: string, jpeg: Buffer): void {
    const channel = this.channels.get(botId);
    // Only a live session feeds frames; one that arrives after the session ended is stale.
    if (!channel || channel.state !== "live") return;
    channel.lastFrame = jpeg;
    for (const ws of channel.viewers) this.sendFrame(ws, jpeg);
  }

  broadcastPage(botId: string, info: PageInfo): void {
    const channel = this.channels.get(botId);
    if (!channel || channel.state !== "live") return;
    channel.lastPage = { url: info.url, title: info.title };
    for (const ws of channel.viewers) this.send(ws, { t: "page", url: info.url, title: info.title });
  }

  setState(botId: string, state: ViewerState): void {
    // A live session keeps its channel without viewers, so a viewer joining later gets the last frame.
    const channel = this.channels.get(botId) ?? (state === "live" ? this.createChannel(botId, state) : null);
    if (!channel) return;

    channel.state = state;
    if (state !== "live") {
      channel.lastFrame = null;
      channel.lastPage = null;
    }
    for (const ws of channel.viewers) this.send(ws, { t: "state", state });
    this.dropIfUnused(botId, channel);
  }

  closeAll(botId: string): void {
    const channel = this.channels.get(botId);
    if (!channel) return;
    this.channels.delete(botId);
    for (const ws of channel.viewers) ws.close(NORMAL_CLOSURE, "closed");
    channel.viewers.clear();
  }

  private createChannel(botId: string, state: ViewerState): Channel {
    const channel: Channel = { viewers: new Set(), state, lastFrame: null, lastPage: null };
    this.channels.set(botId, channel);
    return channel;
  }

  private remove(botId: string, ws: ViewerSocket): void {
    const channel = this.channels.get(botId);
    if (!channel || !channel.viewers.delete(ws)) return;
    this.logger.debug("viewer left", { botId, viewers: channel.viewers.size });
    this.dropIfUnused(botId, channel);
  }

  private dropIfUnused(botId: string, channel: Channel): void {
    if (channel.viewers.size === 0 && channel.state !== "live") this.channels.delete(botId);
  }

  private send(ws: ViewerSocket, message: AgentBrowserViewerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  private sendFrame(ws: ViewerSocket, jpeg: Buffer): void {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > this.maxBufferedBytes) return;
    ws.send(jpeg);
  }
}

export type { ViewerSocket, ViewerState };
export { ViewerHub };
