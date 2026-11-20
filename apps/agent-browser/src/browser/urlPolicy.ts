import { BlockList, isIP } from "node:net";
import { AGENT_BROWSER_MAX_URL_LENGTH } from "@calcom/lib/agentBrowser/contract";

type UrlCheckResult = { ok: true; url: URL } | { ok: false; reason: string };
type LookupAddress = { address: string; family: number };
// Matches `dns.promises.lookup(hostname, { all: true })`, which is what production passes in.
type HostLookup = (hostname: string) => Promise<LookupAddress[]>;

class BlockedHostError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BlockedHostError";
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".internal", ".local"];

// Everything that is not routable on the public internet. The network firewall is the real boundary;
// this list lets the browser refuse such targets early and give the agent a readable reason.
const PRIVATE_V4_SUBNETS: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

// ::/96 covers the unspecified and loopback addresses as well as the deprecated IPv4-compatible form.
const PRIVATE_V6_SUBNETS: ReadonlyArray<[string, number]> = [
  ["::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
];

const privateAddresses = new BlockList();
for (const [network, prefix] of PRIVATE_V4_SUBNETS) privateAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of PRIVATE_V6_SUBNETS) privateAddresses.addSubnet(network, prefix, "ipv6");

const stripBrackets = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

// BlockList matches an IPv4-mapped IPv6 address (::ffff:a.b.c.d, also written ::ffff:a00:1)
// against the IPv4 rules, so a mapped private address is caught without extra parsing.
function isPrivateAddress(address: string): boolean {
  const bare = stripBrackets(address);
  const family = isIP(bare);
  if (family === 4) return privateAddresses.check(bare, "ipv4");
  if (family === 6) return privateAddresses.check(bare, "ipv6");
  return false;
}

const normalizeHostname = (hostname: string): string =>
  stripBrackets(hostname.toLowerCase()).replace(/\.$/, "");

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "" || host === "localhost") return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isPrivateAddress(host);
}

function checkNavigableUrl(raw: string): UrlCheckResult {
  if (raw.length > AGENT_BROWSER_MAX_URL_LENGTH) {
    return { ok: false, reason: `URL is longer than ${AGENT_BROWSER_MAX_URL_LENGTH} characters` };
  }
  if (!URL.canParse(raw)) return { ok: false, reason: "URL is not valid" };

  const url = new URL(raw);
  if (!ALLOWED_PROTOCOLS.has(url.protocol))
    return { ok: false, reason: "only http and https URLs are allowed" };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "URLs with embedded credentials are not allowed" };
  }
  if (isBlockedHostname(url.hostname))
    return { ok: false, reason: "local and private addresses are not allowed" };
  return { ok: true, url };
}

// A public-looking name can still resolve to an internal address, so every resolved address must be public.
async function assertPublicHost(hostname: string, lookup: HostLookup): Promise<void> {
  if (isBlockedHostname(hostname)) throw new BlockedHostError("local and private addresses are not allowed");

  const host = normalizeHostname(hostname);
  if (isIP(host) !== 0) return;

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new BlockedHostError("host could not be resolved");
  }

  if (addresses.length === 0) throw new BlockedHostError("host could not be resolved");
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new BlockedHostError("host resolves to a private address");
  }
}

export type { HostLookup, LookupAddress, UrlCheckResult };
export { assertPublicHost, BlockedHostError, checkNavigableUrl, isBlockedHostname, isPrivateAddress };
