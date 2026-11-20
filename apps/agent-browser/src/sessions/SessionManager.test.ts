// @vitest-environment node
import { AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS } from "@calcom/lib/agentBrowser/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createSilentLogger } from "../logger";
import type { ViewerSocket } from "../viewer/ViewerHub";
import { ViewerHub } from "../viewer/ViewerHub";
import { FakeBrowserDriver } from "./FakeBrowserDriver";
import { AgentBrowserActionError } from "./IBrowserDriver";
import { SessionManager } from "./SessionManager";

const IDLE_MS = 600_000;
const MAX_AGE_MS = 18_000_000;

class FakeSocket implements ViewerSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<string | Buffer> = [];
  closed = false;
  private closeListener: (() => void) | null = null;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.closeListener?.();
  }

  once(_event: "close", listener: () => void): void {
    this.closeListener = listener;
  }

  texts(): unknown[] {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data));
  }
}

const expectActionError = async (promise: Promise<unknown>, code: string): Promise<void> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(AgentBrowserActionError);
  if (error instanceof AgentBrowserActionError) expect(error.code).toBe(code);
};

describe("SessionManager", () => {
  let clock: number;
  let driver: FakeBrowserDriver;
  let hub: ViewerHub;
  let manager: SessionManager;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    driver = new FakeBrowserDriver();
    hub = new ViewerHub({ logger: createSilentLogger() });
    manager = new SessionManager({
      driver,
      hub,
      maxSessions: 2,
      idleTimeoutMs: IDLE_MS,
      maxSessionMs: MAX_AGE_MS,
      now: () => clock,
      logger: createSilentLogger(),
    });
  });

  describe("perform", () => {
    it("creates a session on goto and reports created only for that call", async () => {
      const first = await manager.perform("bot1", { type: "goto", url: "https://example.com/" });

      expect(first).toEqual({
        created: true,
        url: "https://example.com/",
        title: "Title of https://example.com/",
        snapshot: "Fake snapshot of https://example.com/",
        viewers: 0,
        screenshot: null,
      });
      expect(manager.stats()).toEqual({ sessions: 1, maxSessions: 2 });

      const second = await manager.perform("bot1", { type: "goto", url: "https://example.org/" });
      expect(second.created).toBe(false);
      expect(driver.sessions).toHaveLength(1);
    });

    it("reports the current viewer count and the screenshot of a screenshot action", async () => {
      hub.add("bot1", new FakeSocket());
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });

      const state = await manager.perform("bot1", { type: "screenshot" });

      expect(state.viewers).toBe(1);
      expect(state.screenshot?.mediaType).toBe("image/jpeg");
    });

    it("caps the title at the contract length", async () => {
      await manager.perform("bot1", { type: "goto", url: `https://example.com/${"x".repeat(400)}` });

      const state = await manager.perform("bot1", { type: "snapshot" });

      expect(state.title).toHaveLength(300);
    });

    it("refuses every action but goto when the bot has no session", async () => {
      await expectActionError(manager.perform("bot1", { type: "snapshot" }), "SESSION_NOT_FOUND");
      await expectActionError(manager.perform("bot1", { type: "click", ref: "e1" }), "SESSION_NOT_FOUND");
      expect(driver.sessions).toHaveLength(0);
    });

    it("refuses a new session when the cap is reached, counting sessions still being created", async () => {
      const results = await Promise.allSettled([
        manager.perform("bot1", { type: "goto", url: "https://example.com/" }),
        manager.perform("bot2", { type: "goto", url: "https://example.com/" }),
        manager.perform("bot3", { type: "goto", url: "https://example.com/" }),
      ]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
      await expectActionError(
        manager.perform("bot4", { type: "goto", url: "https://example.com/" }),
        "CAPACITY"
      );
      await manager.destroy("bot1");
      await expect(
        manager.perform("bot4", { type: "goto", url: "https://example.com/" })
      ).resolves.toMatchObject({
        created: true,
      });
    });

    it("serializes actions for the same bot", async () => {
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      const session = driver.lastSession("bot1");
      if (!session) throw new Error("expected a session");
      const release = session.holdNext();

      const order: string[] = [];
      const click = manager.perform("bot1", { type: "click", ref: "e1" }).then(() => order.push("click"));
      const snapshot = manager.perform("bot1", { type: "snapshot" }).then(() => order.push("snapshot"));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(session.performed.map((action) => action.type)).toEqual(["goto", "click"]);
      release();
      await Promise.all([click, snapshot]);
      expect(order).toEqual(["click", "snapshot"]);
    });

    it("keeps the queue going after an action fails", async () => {
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      driver.lastSession("bot1")?.failNext(new AgentBrowserActionError("STALE_REF", "That element is gone."));

      await expectActionError(manager.perform("bot1", { type: "click", ref: "e9" }), "STALE_REF");
      await expect(manager.perform("bot1", { type: "snapshot" })).resolves.toMatchObject({ created: false });
    });

    it("does not serialize actions of different bots", async () => {
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      const held = driver.lastSession("bot1");
      const release = held?.holdNext() ?? (() => {});
      const blocked = manager.perform("bot1", { type: "snapshot" });

      await expect(
        manager.perform("bot2", { type: "goto", url: "https://example.org/" })
      ).resolves.toMatchObject({
        created: true,
      });
      release();
      await blocked;
    });

    it("drops a session whose first goto failed so it does not hold a slot", async () => {
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      const session = driver.lastSession("bot1");
      await manager.destroy("bot1");
      expect(session?.disposed).toBe(true);

      const original = driver.createSession.bind(driver);
      driver.createSession = async (botId, hooks) => {
        const created = await original(botId, hooks);
        created.failNext(new AgentBrowserActionError("BLOCKED_URL", "That address is not allowed."));
        return created;
      };

      await expectActionError(
        manager.perform("bot2", { type: "goto", url: "http://10.0.0.1/" }),
        "BLOCKED_URL"
      );
      expect(manager.stats().sessions).toBe(0);
      expect(driver.lastSession("bot2")?.disposed).toBe(true);
    });

    it("replaces a session whose browser closed on the next goto, keeping viewers attached", async () => {
      const ws = new FakeSocket();
      hub.add("bot1", ws);
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      const crashed = driver.lastSession("bot1");
      crashed?.crash();

      const state = await manager.perform("bot1", { type: "goto", url: "https://example.org/" });

      expect(state).toMatchObject({ created: true, url: "https://example.org/" });
      expect(crashed?.disposed).toBe(true);
      expect(driver.sessions).toHaveLength(2);
      expect(manager.stats().sessions).toBe(1);
      expect(ws.closed).toBe(false);
      expect(ws.texts().slice(-3)).toEqual([
        { t: "state", state: "waiting" },
        { t: "state", state: "live" },
        { t: "page", url: "https://example.org/", title: "Title of https://example.org/" },
      ]);
    });

    it("refuses other actions once the browser closed so the agent opens a page again", async () => {
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      const crashed = driver.lastSession("bot1");
      crashed?.crash();

      await expectActionError(manager.perform("bot1", { type: "click", ref: "e1" }), "SESSION_NOT_FOUND");

      expect(crashed?.disposed).toBe(true);
      expect(crashed?.performed).toHaveLength(1);
      expect(manager.stats().sessions).toBe(0);
      expect(driver.sessions).toHaveLength(1);
    });

    it("maps a driver failure to INTERNAL without leaking its message", async () => {
      driver.failNextCreate(new Error("browserType.launch: Executable doesn't exist at /secret/path"));

      const result = manager.perform("bot1", { type: "goto", url: "https://example.com/" });

      await expectActionError(result, "INTERNAL");
      await expect(result).rejects.not.toThrow("/secret/path");
      expect(manager.stats().sessions).toBe(0);
    });
  });

  describe("viewer wiring", () => {
    it("marks the bot live on creation and forwards frames and pages to its viewers", async () => {
      const ws = new FakeSocket();
      hub.add("bot1", ws);

      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      driver.lastSession("bot1")?.emitFrame(Buffer.from("jpeg"));

      expect(ws.texts()).toEqual([
        { t: "hello", width: 1280, height: 680, state: "waiting" },
        { t: "state", state: "live" },
        { t: "page", url: "https://example.com/", title: "Title of https://example.com/" },
      ]);
      expect(ws.sent.at(-1)).toEqual(Buffer.from("jpeg"));
    });

    it("stops forwarding frames from a disposed session", async () => {
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      const session = driver.lastSession("bot1");
      await manager.destroy("bot1");
      const ws = new FakeSocket();
      hub.add("bot1", ws);

      session?.emitFrame(Buffer.from("late"));

      expect(ws.sent).toHaveLength(1);
    });
  });

  describe("destroy", () => {
    it("disposes the session, tells viewers it closed and closes them", async () => {
      const ws = new FakeSocket();
      hub.add("bot1", ws);
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });

      await manager.destroy("bot1");

      expect(driver.lastSession("bot1")?.disposed).toBe(true);
      expect(ws.texts().at(-1)).toEqual({ t: "state", state: "closed" });
      expect(ws.closed).toBe(true);
      expect(hub.count("bot1")).toBe(0);
      expect(manager.stats().sessions).toBe(0);
      await expectActionError(manager.perform("bot1", { type: "snapshot" }), "SESSION_NOT_FOUND");
    });

    it("is idempotent and works for a bot that never had a session", async () => {
      await expect(manager.destroy("bot1")).resolves.toBeUndefined();
      await expect(manager.destroy("bot1")).resolves.toBeUndefined();
    });

    it("sets a revocation tombstone for tokens issued up to the same second", async () => {
      expect(manager.isRevoked("bot1", new Date(clock - 60_000))).toBe(false);

      await manager.destroy("bot1");

      expect(manager.isRevoked("bot1", new Date(clock - 60_000))).toBe(true);
      expect(manager.isRevoked("bot1", new Date(clock))).toBe(true);
      expect(manager.isRevoked("bot1", new Date(clock + 1000))).toBe(false);
      expect(manager.isRevoked("bot2", new Date(clock - 60_000))).toBe(false);
    });

    it("waits for an in-flight action before disposing, but tells viewers immediately", async () => {
      const ws = new FakeSocket();
      hub.add("bot1", ws);
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      const session = driver.lastSession("bot1");
      const release = session?.holdNext() ?? (() => {});
      const inFlight = manager.perform("bot1", { type: "snapshot" });

      const destroyed = manager.destroy("bot1");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ws.closed).toBe(true);
      expect(session?.disposed).toBe(false);

      release();
      await inFlight;
      await destroyed;
      expect(session?.disposed).toBe(true);
    });
  });

  describe("reap", () => {
    it("reaps a session idle past the timeout with no viewers", async () => {
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      clock += IDLE_MS - 1;
      await manager.reap();
      expect(manager.stats().sessions).toBe(1);

      clock += 1;
      await manager.reap();

      expect(manager.stats().sessions).toBe(0);
      expect(driver.lastSession("bot1")?.disposed).toBe(true);
    });

    it("keeps an idle session that is being watched, and measures idleness from when watching stopped", async () => {
      const ws = new FakeSocket();
      hub.add("bot1", ws);
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });

      clock += IDLE_MS * 3;
      await manager.reap();
      expect(manager.stats().sessions).toBe(1);

      ws.close();
      clock += IDLE_MS - 1;
      await manager.reap();
      expect(manager.stats().sessions).toBe(1);

      clock += 1;
      await manager.reap();
      expect(manager.stats().sessions).toBe(0);
    });

    it("counts an action as activity", async () => {
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      clock += IDLE_MS - 1;
      await manager.perform("bot1", { type: "snapshot" });
      clock += IDLE_MS - 1;

      await manager.reap();

      expect(manager.stats().sessions).toBe(1);
    });

    it("reaps a session past its maximum age even while watched, and leaves viewers waiting", async () => {
      const ws = new FakeSocket();
      hub.add("bot1", ws);
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });

      clock += MAX_AGE_MS;
      await manager.reap();

      expect(manager.stats().sessions).toBe(0);
      expect(ws.closed).toBe(false);
      expect(ws.texts().at(-1)).toEqual({ t: "state", state: "waiting" });
      expect(manager.isRevoked("bot1", new Date(clock - 1000))).toBe(false);

      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      expect(ws.texts().at(-2)).toEqual({ t: "state", state: "live" });
    });

    it("reaps a session whose browser closed even while watched, and leaves viewers waiting", async () => {
      const ws = new FakeSocket();
      hub.add("bot1", ws);
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      driver.lastSession("bot1")?.crash();

      await manager.reap();

      expect(manager.stats().sessions).toBe(0);
      expect(driver.lastSession("bot1")?.disposed).toBe(true);
      expect(ws.closed).toBe(false);
      expect(ws.texts().at(-1)).toEqual({ t: "state", state: "waiting" });
    });

    it("forgets tombstones once every token they could revoke has expired", async () => {
      await manager.destroy("bot1");
      const revokedAt = clock;

      clock += AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS * 1000;
      await manager.reap();
      expect(manager.isRevoked("bot1", new Date(revokedAt - 1000))).toBe(true);

      clock += 1;
      await manager.reap();
      expect(manager.isRevoked("bot1", new Date(revokedAt - 1000))).toBe(false);
    });
  });

  describe("disposeAll", () => {
    it("disposes every session without waiting for an in-flight action and refuses new ones", async () => {
      await manager.perform("bot1", { type: "goto", url: "https://example.com/" });
      await manager.perform("bot2", { type: "goto", url: "https://example.org/" });
      const release = driver.lastSession("bot1")?.holdNext();
      const inFlight = manager.perform("bot1", { type: "snapshot" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(driver.lastSession("bot1")?.performed.at(-1)).toEqual({ type: "snapshot" });

      await manager.disposeAll();

      expect(manager.stats().sessions).toBe(0);
      expect(driver.sessions.every((session) => session.disposed)).toBe(true);
      release?.();
      await expectActionError(inFlight, "ACTION_FAILED");
      await expectActionError(
        manager.perform("bot3", { type: "goto", url: "https://example.com/" }),
        "INTERNAL"
      );
      expect(driver.sessions).toHaveLength(2);
    });
  });
});
