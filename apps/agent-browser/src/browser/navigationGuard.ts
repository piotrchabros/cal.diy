import { promises as dns } from "node:dns";
import type { HostLookup, UrlCheckResult } from "./urlPolicy";
import { assertPublicHost, BlockedHostError, checkNavigableUrl } from "./urlPolicy";

// Injected so the integration test can serve fixtures from loopback, which the real policy refuses.
type NavigationPolicy = {
  checkUrl(raw: string): UrlCheckResult;
  // Throws BlockedHostError when the host must not be visited.
  assertHost(hostname: string): Promise<void>;
};

type DeniedDecision = { allowed: false; code: "BLOCKED_URL" | "ACTION_FAILED"; message: string };
type GuardDecision = { allowed: true } | DeniedDecision;

type GuardedRequest = { url: string; isNavigation: boolean; isMainFrame: boolean };

const MAX_NAVIGATIONS_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;
// The driver itself parks the page on about:blank, and Chromium commits its own error page when a navigation
// fails (including one the guard aborted); neither is content a site controls.
const INTERNAL_URLS = new Set(["about:blank", "chrome-error://chromewebdata/"]);

const ALLOWED: GuardDecision = { allowed: true };

const systemLookup: HostLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

function blockedUrlDecision(reason: string): DeniedDecision {
  return { allowed: false, code: "BLOCKED_URL", message: `This address cannot be opened: ${reason}.` };
}

function createDefaultNavigationPolicy(lookup: HostLookup = systemLookup): NavigationPolicy {
  return { checkUrl: checkNavigableUrl, assertHost: (hostname) => assertPublicHost(hostname, lookup) };
}

class NavigationGuard {
  private readonly policy: NavigationPolicy;
  private readonly maxNavigationsPerMinute: number;
  private readonly now: () => number;
  private readonly recentNavigations: number[] = [];

  constructor(deps: { policy: NavigationPolicy; maxNavigationsPerMinute?: number; now?: () => number }) {
    this.policy = deps.policy;
    this.maxNavigationsPerMinute = deps.maxNavigationsPerMinute ?? MAX_NAVIGATIONS_PER_MINUTE;
    this.now = deps.now ?? Date.now;
  }

  // A URL the agent asked for, or a popup's URL, before the browser sends anything.
  checkTarget(raw: string): Promise<GuardDecision> {
    if (raw === "about:blank") return Promise.resolve(ALLOWED);
    return this.checkUrlAndHost(raw);
  }

  // Subresources only get the synchronous check: resolving every image host would slow pages down for little
  // gain, since the firewall is what actually stops them.
  async checkRequest(request: GuardedRequest): Promise<GuardDecision> {
    if (!request.isNavigation) return this.checkUrl(request.url);
    const decision = await this.checkUrlAndHost(request.url);
    if (!decision.allowed || !request.isMainFrame) return decision;
    return this.takeNavigationSlot();
  }

  // Route interception never sees redirect hops, so the URL a frame ends up on is checked again.
  checkCommittedUrl(raw: string): Promise<GuardDecision> {
    if (INTERNAL_URLS.has(raw)) return Promise.resolve(ALLOWED);
    return this.checkUrlAndHost(raw);
  }

  private checkUrl(raw: string): GuardDecision {
    const result = this.policy.checkUrl(raw);
    return result.ok ? ALLOWED : blockedUrlDecision(result.reason);
  }

  private async checkUrlAndHost(raw: string): Promise<GuardDecision> {
    const result = this.policy.checkUrl(raw);
    if (!result.ok) return blockedUrlDecision(result.reason);
    try {
      await this.policy.assertHost(result.url.hostname);
      return ALLOWED;
    } catch (error) {
      return blockedUrlDecision(
        error instanceof BlockedHostError ? error.reason : "host could not be checked"
      );
    }
  }

  private takeNavigationSlot(): GuardDecision {
    const now = this.now();
    while (this.recentNavigations.length > 0 && now - (this.recentNavigations[0] ?? now) >= RATE_WINDOW_MS) {
      this.recentNavigations.shift();
    }
    if (this.recentNavigations.length >= this.maxNavigationsPerMinute) {
      return {
        allowed: false,
        code: "ACTION_FAILED",
        message: "Too many pages were opened in the last minute; wait a moment and try again.",
      };
    }
    this.recentNavigations.push(now);
    return ALLOWED;
  }
}

export type { DeniedDecision, GuardDecision, GuardedRequest, NavigationPolicy };
export { blockedUrlDecision, createDefaultNavigationPolicy, NavigationGuard };
