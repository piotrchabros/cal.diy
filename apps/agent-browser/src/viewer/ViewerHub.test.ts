// @vitest-environment node
import { AGENT_BROWSER_VIEWPORT, agentBrowserViewerMessageSchema } from "@calcom/lib/agentBrowser/contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { WebSocket } from "ws";
import { createSilentLogger } from "../logger";
import type { ViewerSocket } from "./ViewerHub";
import { ViewerHub } from "./ViewerHub";

const OPEN = 1;
const CLOSED = 3;

class FakeSocket implements ViewerSocket {
  readyState = OPEN;
  bufferedAmount = 0;
  readonly sent: Array<string | Buffer> = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private closeListeners: Array<() => void> = [];

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = CLOSED;
    this.emitClose();
  }

  once(_event: "close", listener: () => void): void {
    this.closeListeners.push(listener);
  }

  emitClose(): void {
    const listeners = this.closeListeners;
    this.closeListeners = [];
    for (const listener of listeners) listener();
  }

  messages(): unknown[] {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => agentBrowserViewerMessageSchema.parse(JSON.parse(data)));
  }

  frames(): Buffer[] {
    return this.sent.filter((data): data is Buffer => Buffer.isBuffer(data));
  }
}

const createHub = (
  options: { maxViewersPerBot?: number; maxViewers?: number; maxBufferedBytes?: number } = {}
) => new ViewerHub({ logger: createSilentLogger(), ...options });

describe("ViewerHub", () => {
  it("accepts a real ws WebSocket", () => {
    expectTypeOf<WebSocket>().toExtend<ViewerSocket>();
  });

  it("greets a viewer of a bot without a session as waiting", () => {
    const hub = createHub();
    const ws = new FakeSocket();

    expect(hub.add("bot1", ws)).toBe(true);

    expect(ws.messages()).toEqual([
      {
        t: "hello",
        width: AGENT_BROWSER_VIEWPORT.width,
        height: AGENT_BROWSER_VIEWPORT.height,
        state: "waiting",
      },
    ]);
    expect(hub.count("bot1")).toBe(1);
  });

  it("sends the last page and frame of a live session to a viewer that joins later", () => {
    const hub = createHub();
    hub.setState("bot1", "live");
    hub.broadcastPage("bot1", { url: "https://example.com/", title: "Example" });
    hub.broadcastFrame("bot1", Buffer.from("frame-1"));
    hub.broadcastFrame("bot1", Buffer.from("frame-2"));

    const ws = new FakeSocket();
    hub.add("bot1", ws);

    expect(ws.messages()).toEqual([
      { t: "hello", width: 1280, height: 680, state: "live" },
      { t: "page", url: "https://example.com/", title: "Example" },
    ]);
    expect(ws.frames()).toEqual([Buffer.from("frame-2")]);
  });

  it("fans frames, pages and states out to every viewer of the bot only", () => {
    const hub = createHub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const other = new FakeSocket();
    hub.add("bot1", a);
    hub.add("bot1", b);
    hub.add("bot2", other);

    hub.setState("bot1", "live");
    hub.broadcastPage("bot1", { url: "https://example.com/", title: "Example" });
    hub.broadcastFrame("bot1", Buffer.from("frame"));

    for (const ws of [a, b]) {
      expect(ws.messages().slice(1)).toEqual([
        { t: "state", state: "live" },
        { t: "page", url: "https://example.com/", title: "Example" },
      ]);
      expect(ws.frames()).toEqual([Buffer.from("frame")]);
    }
    expect(other.sent).toHaveLength(1);
  });

  it("ignores frames and pages for a bot that is not live", () => {
    const hub = createHub();
    const ws = new FakeSocket();
    hub.add("bot1", ws);

    hub.broadcastFrame("bot1", Buffer.from("stale"));
    hub.broadcastPage("bot1", { url: "https://example.com/", title: "Example" });
    hub.broadcastFrame("nobody", Buffer.from("stale"));

    expect(ws.sent).toHaveLength(1);
  });

  it("forgets the last frame once the session is no longer live", () => {
    const hub = createHub();
    hub.setState("bot1", "live");
    hub.broadcastFrame("bot1", Buffer.from("old"));
    hub.setState("bot1", "waiting");
    hub.setState("bot1", "live");

    const ws = new FakeSocket();
    hub.add("bot1", ws);

    expect(ws.frames()).toEqual([]);
  });

  it("skips frames for a viewer whose send buffer is over the limit but still sends text", () => {
    const hub = createHub({ maxBufferedBytes: 100 });
    const slow = new FakeSocket();
    const fast = new FakeSocket();
    hub.add("bot1", slow);
    hub.add("bot1", fast);
    hub.setState("bot1", "live");
    slow.bufferedAmount = 101;

    hub.broadcastFrame("bot1", Buffer.from("frame"));
    hub.broadcastPage("bot1", { url: "https://example.com/", title: "Example" });

    expect(slow.frames()).toEqual([]);
    expect(fast.frames()).toEqual([Buffer.from("frame")]);
    expect(slow.messages()).toContainEqual({ t: "page", url: "https://example.com/", title: "Example" });
  });

  it("does not send to a socket that is no longer open", () => {
    const hub = createHub();
    const ws = new FakeSocket();
    hub.add("bot1", ws);
    hub.setState("bot1", "live");
    ws.readyState = CLOSED;

    hub.broadcastFrame("bot1", Buffer.from("frame"));

    expect(ws.frames()).toEqual([]);
  });

  it("refuses a viewer over the per-bot cap", () => {
    const hub = createHub({ maxViewersPerBot: 2 });
    expect(hub.add("bot1", new FakeSocket())).toBe(true);
    expect(hub.add("bot1", new FakeSocket())).toBe(true);

    const refused = new FakeSocket();
    expect(hub.add("bot1", refused)).toBe(false);
    expect(refused.sent).toEqual([]);
    expect(hub.add("bot2", new FakeSocket())).toBe(true);
  });

  it("refuses a viewer over the global cap", () => {
    const hub = createHub({ maxViewers: 2 });
    hub.add("bot1", new FakeSocket());
    hub.add("bot2", new FakeSocket());

    expect(hub.add("bot3", new FakeSocket())).toBe(false);
    expect(hub.total()).toBe(2);
  });

  it("counts viewers and frees their slot when they disconnect", () => {
    const hub = createHub({ maxViewersPerBot: 1 });
    const ws = new FakeSocket();
    hub.add("bot1", ws);
    hub.add("bot2", new FakeSocket());
    expect(hub.count("bot1")).toBe(1);
    expect(hub.total()).toBe(2);

    ws.emitClose();

    expect(hub.count("bot1")).toBe(0);
    expect(hub.total()).toBe(1);
    expect(hub.add("bot1", new FakeSocket())).toBe(true);
  });

  it("closeAll closes every viewer of the bot and forgets the channel", () => {
    const hub = createHub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.add("bot1", a);
    hub.add("bot1", b);
    hub.setState("bot1", "live");
    hub.broadcastFrame("bot1", Buffer.from("frame"));

    hub.setState("bot1", "closed");
    hub.closeAll("bot1");

    for (const ws of [a, b]) {
      expect(ws.messages().at(-1)).toEqual({ t: "state", state: "closed" });
      expect(ws.closedWith).toEqual({ code: 1000, reason: "closed" });
    }
    expect(hub.count("bot1")).toBe(0);
    hub.broadcastFrame("bot1", Buffer.from("late"));
    const next = new FakeSocket();
    hub.add("bot1", next);
    expect(next.messages()).toEqual([{ t: "hello", width: 1280, height: 680, state: "waiting" }]);
    expect(next.frames()).toEqual([]);
  });

  it("canAdd reports whether another viewer of the bot fits under both caps", () => {
    const hub = createHub({ maxViewersPerBot: 1, maxViewers: 2 });
    expect(hub.canAdd("bot1")).toBe(true);

    hub.add("bot1", new FakeSocket());
    expect(hub.canAdd("bot1")).toBe(false);
    expect(hub.canAdd("bot2")).toBe(true);

    hub.add("bot2", new FakeSocket());
    expect(hub.canAdd("bot3")).toBe(false);
  });

  it("closeEveryViewer closes all viewers as a restart without a closed state", () => {
    const hub = createHub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.add("bot1", a);
    hub.add("bot2", b);
    hub.setState("bot1", "live");

    hub.closeEveryViewer();

    for (const ws of [a, b]) {
      expect(ws.closedWith).toEqual({ code: 1012, reason: "restarting" });
      expect(ws.messages()).not.toContainEqual({ t: "state", state: "closed" });
    }
    expect(hub.total()).toBe(0);
  });
});
