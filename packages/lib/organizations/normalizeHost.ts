const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function normalizeHost(host: string | null | undefined): string | null {
  const trimmed = host?.trim();
  if (!trimmed) return null;

  let normalized = trimmed.toLowerCase();

  if (normalized.startsWith("[")) {
    const closingBracketIndex = normalized.indexOf("]");
    if (closingBracketIndex !== -1) {
      normalized = normalized.slice(0, closingBracketIndex + 1);
    }
  } else if (normalized.split(":").length === 2) {
    // A bare IPv6 address has several colons, so only a single colon marks a port
    normalized = normalized.slice(0, normalized.indexOf(":"));
  }

  normalized = normalized.replace(/\.+$/, "");

  return normalized || null;
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  return LOOPBACK_HOSTS.has(normalized);
}
