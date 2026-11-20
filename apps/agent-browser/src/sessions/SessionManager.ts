import type { AgentBrowserAction, AgentBrowserPageState } from "@calcom/lib/agentBrowser/contract";
import { AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS } from "@calcom/lib/agentBrowser/contract";
import type { Logger } from "../logger";
import type { ViewerHub } from "../viewer/ViewerHub";
import type { IBrowserDriver, IBrowserSession } from "./IBrowserDriver";
import { AgentBrowserActionError } from "./IBrowserDriver";

type SessionEntry = {
  botId: string;
  session: IBrowserSession;
  createdAt: number;
  // Last time the session had an action or was watched; the idle reaper measures from here.
  lastActivityAt: number;
  active: boolean;
};

const MAX_TITLE_LENGTH = 300;

class SessionManager {
  private readonly driver: IBrowserDriver;
  private readonly hub: ViewerHub;
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly maxSessionMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly locks = new Map<string, Promise<void>>();
  // Viewer tokens are stateless, so closing a session can only revoke them by remembering when it happened.
  private readonly revokedBefore = new Map<string, Date>();
  private pendingCreations = 0;
  private shuttingDown = false;

  constructor(deps: {
    driver: IBrowserDriver;
    hub: ViewerHub;
    maxSessions: number;
    idleTimeoutMs: number;
    maxSessionMs: number;
    now?: () => number;
    logger: Logger;
  }) {
    this.driver = deps.driver;
    this.hub = deps.hub;
    this.maxSessions = deps.maxSessions;
    this.idleTimeoutMs = deps.idleTimeoutMs;
    this.maxSessionMs = deps.maxSessionMs;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger;
  }

  perform(botId: string, action: AgentBrowserAction): Promise<AgentBrowserPageState> {
    return this.withLock(botId, () => this.performLocked(botId, action));
  }

  async destroy(botId: string): Promise<void> {
    this.revokedBefore.set(botId, new Date(this.now()));
    // Viewers are told right away rather than after an in-flight action, which can take up to its timeout.
    this.hub.setState(botId, "closed");
    this.hub.closeAll(botId);

    await this.withLock(botId, async () => {
      const entry = this.entries.get(botId);
      if (!entry) return;
      await this.disposeEntry(entry, "destroyed");
      this.hub.closeAll(botId);
    });
  }

  isRevoked(botId: string, issuedAt: Date): boolean {
    const revokedAt = this.revokedBefore.get(botId);
    if (!revokedAt) return false;
    // Token times have whole-second precision, so a token from the same second as the revocation
    // cannot be told apart from one issued just before it and is treated as revoked.
    return Math.floor(issuedAt.getTime() / 1000) <= Math.floor(revokedAt.getTime() / 1000);
  }

  async reap(): Promise<void> {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (this.hub.count(entry.botId) > 0) entry.lastActivityAt = now;
      if (!this.reapReason(entry, now)) continue;

      await this.withLock(entry.botId, async () => {
        // The entry may have been replaced, or used, while waiting for the lock.
        const reason = this.entries.get(entry.botId) === entry ? this.reapReason(entry, this.now()) : null;
        if (!reason) return;
        await this.disposeEntry(entry, reason);
        // Viewers stay connected: the next `goto` for this bot makes the same viewer live again.
        this.hub.setState(entry.botId, "waiting");
      });
    }

    // Tokens issued before a tombstone have expired by now, so the tombstone protects nothing.
    const tombstoneTtlMs = AGENT_BROWSER_MAX_TOKEN_TTL_SECONDS * 1000;
    for (const [botId, revokedAt] of this.revokedBefore) {
      if (now - revokedAt.getTime() > tombstoneTtlMs) this.revokedBefore.delete(botId);
    }
  }

  // Shutdown does not wait for the per-bot locks: an in-flight action can hold one for its whole timeout.
  async disposeAll(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.entries.values()].map((entry) => this.disposeEntry(entry, "shutdown")));
  }

  stats(): { sessions: number; maxSessions: number } {
    return { sessions: this.entries.size, maxSessions: this.maxSessions };
  }

  private async performLocked(botId: string, action: AgentBrowserAction): Promise<AgentBrowserPageState> {
    let entry = this.entries.get(botId);
    let created = false;
    // A crashed browser leaves a session that fails every action, so it is dropped and goto starts over.
    if (entry?.session.isClosed()) {
      await this.disposeEntry(entry, "closed");
      this.hub.setState(botId, "waiting");
      entry = undefined;
    }
    if (!entry) {
      if (action.type !== "goto") {
        throw new AgentBrowserActionError(
          "SESSION_NOT_FOUND",
          "No browser session is open for this meeting; open a page first."
        );
      }
      entry = await this.createEntry(botId);
      created = true;
    }

    entry.lastActivityAt = this.now();
    try {
      const result = await entry.session.perform(action);
      entry.lastActivityAt = this.now();
      return {
        created,
        url: result.url,
        title: result.title.slice(0, MAX_TITLE_LENGTH),
        snapshot: result.snapshot,
        viewers: this.hub.count(botId),
        screenshot: result.screenshot,
      };
    } catch (error) {
      // A session whose first page failed shows nothing, so it would only hold a slot until reaped.
      if (created) {
        await this.disposeEntry(entry, "first_action_failed");
        this.hub.setState(botId, "waiting");
      }
      throw error;
    }
  }

  private async createEntry(botId: string): Promise<SessionEntry> {
    if (this.shuttingDown) {
      throw new AgentBrowserActionError("INTERNAL", "The browser service is shutting down.");
    }
    if (this.entries.size + this.pendingCreations >= this.maxSessions) {
      throw new AgentBrowserActionError("CAPACITY", "Too many browser sessions are open; try again later.");
    }

    this.pendingCreations += 1;
    const holder: { entry: SessionEntry | null } = { entry: null };
    let session: IBrowserSession;
    try {
      session = await this.driver.createSession(botId, {
        // Hooks of a disposed session can still fire while its context shuts down.
        onFrame: (jpeg) => {
          if (holder.entry?.active) this.hub.broadcastFrame(botId, jpeg);
        },
        onPage: (info) => {
          if (holder.entry?.active) this.hub.broadcastPage(botId, info);
        },
      });
    } catch (error) {
      this.logger.error("browser session could not be created", {
        botId,
        error: error instanceof Error ? error.name : "unknown",
      });
      throw new AgentBrowserActionError("INTERNAL", "The browser could not open a session.");
    } finally {
      this.pendingCreations -= 1;
    }

    const now = this.now();
    const entry: SessionEntry = { botId, session, createdAt: now, lastActivityAt: now, active: true };
    holder.entry = entry;
    this.entries.set(botId, entry);
    this.hub.setState(botId, "live");
    this.logger.info("browser session created", { botId, sessions: this.entries.size });
    return entry;
  }

  private reapReason(entry: SessionEntry, now: number): string | null {
    if (entry.session.isClosed()) return "closed";
    if (now - entry.createdAt >= this.maxSessionMs) return "max_age";
    if (now - entry.lastActivityAt >= this.idleTimeoutMs && this.hub.count(entry.botId) === 0) return "idle";
    return null;
  }

  private async disposeEntry(entry: SessionEntry, reason: string): Promise<void> {
    if (!entry.active) return;
    entry.active = false;
    if (this.entries.get(entry.botId) === entry) this.entries.delete(entry.botId);

    try {
      await entry.session.dispose();
    } catch (error) {
      this.logger.warn("browser session dispose failed", {
        botId: entry.botId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    this.logger.info("browser session closed", { botId: entry.botId, reason, sessions: this.entries.size });
  }

  // Chains tasks per bot so actions never interleave on one page; the stored tail never rejects.
  private withLock<T>(botId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(botId) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(botId, tail);
    void tail.then(() => {
      if (this.locks.get(botId) === tail) this.locks.delete(botId);
    });
    return result;
  }
}

export { SessionManager };
