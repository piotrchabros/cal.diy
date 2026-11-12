import dns from "node:dns/promises";
import { isIP } from "node:net";
import { ORGANIZATION_SMTP_ALLOWED_PORTS } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";
import { isBlockedHostname, isPrivateIP } from "@calcom/lib/ssrfProtection";
import ipaddr from "ipaddr.js";

const MAX_HOSTNAME_LENGTH = 253;
const HOSTNAME_LABEL_REGEX = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function stripIPv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

// Link-local covers cloud metadata endpoints (169.254.169.254), which stay blocked even when
// private addresses are allowed for self-hosted relays.
function isLinkLocalAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  const parsed = ipaddr.process(address);
  return parsed.range() === "linkLocal";
}

function checkAddress(address: string, allowPrivate: boolean): SmtpHostError | null {
  if (isLinkLocalAddress(address)) return SMTP_HOST_ERRORS.blockedHost;
  if (!allowPrivate && isPrivateIP(address)) return SMTP_HOST_ERRORS.privateAddress;
  return null;
}

export const SMTP_HOST_ERRORS = {
  invalidHost: "organization_smtp_host_invalid",
  blockedHost: "organization_smtp_host_blocked",
  privateAddress: "organization_smtp_host_private",
  dnsFailure: "organization_smtp_host_unresolvable",
  portNotAllowed: "organization_smtp_port_not_allowed",
} as const;

export type SmtpHostError = (typeof SMTP_HOST_ERRORS)[keyof typeof SMTP_HOST_ERRORS];

export type SmtpHostResolution = { ok: true; address: string } | { ok: false; error: SmtpHostError };

export function parseSmtpHost(raw: string): string | null {
  const host = stripIPv6Brackets(raw.trim().toLowerCase()).replace(/\.$/, "");
  if (!host || host.length > MAX_HOSTNAME_LENGTH) return null;
  if (isIP(host) !== 0) return host;

  const labels = host.split(".");
  if (!labels.every((label) => HOSTNAME_LABEL_REGEX.test(label))) return null;
  // An all-numeric final label means a malformed IPv4 literal rather than a hostname.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return host;
}

export function isSmtpPortAllowed(port: number): boolean {
  return (ORGANIZATION_SMTP_ALLOWED_PORTS as readonly number[]).includes(port);
}

/**
 * Resolves the SMTP host once and returns the address to connect to. Callers must connect to the
 * returned address (not the hostname) so a second DNS lookup cannot rebind to an internal host.
 */
export async function resolveSmtpHostAddress(
  host: string,
  opts?: { allowPrivate?: boolean }
): Promise<SmtpHostResolution> {
  const allowPrivate = opts?.allowPrivate ?? false;
  const parsedHost = parseSmtpHost(host);
  if (!parsedHost) return { ok: false, error: SMTP_HOST_ERRORS.invalidHost };

  if (!allowPrivate && isBlockedHostname(parsedHost)) {
    return { ok: false, error: SMTP_HOST_ERRORS.blockedHost };
  }

  if (isIP(parsedHost) !== 0) {
    const error = checkAddress(parsedHost, allowPrivate);
    if (error) return { ok: false, error };
    return { ok: true, address: parsedHost };
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(parsedHost, { all: true });
  } catch {
    return { ok: false, error: SMTP_HOST_ERRORS.dnsFailure };
  }
  if (addresses.length === 0) return { ok: false, error: SMTP_HOST_ERRORS.dnsFailure };

  for (const { address } of addresses) {
    const error = checkAddress(address, allowPrivate);
    if (error) return { ok: false, error };
  }

  return { ok: true, address: addresses[0].address };
}
