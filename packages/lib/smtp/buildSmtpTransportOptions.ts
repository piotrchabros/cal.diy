import { isIP } from "node:net";
import type { OrganizationSmtpTransportConfig } from "@calcom/lib/dto/OrganizationSmtpSettingsDto";

const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;

export type SmtpTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  ignoreTLS: boolean;
  auth?: { user: string; pass: string };
  tls: { servername?: string; rejectUnauthorized: true; minVersion: "TLSv1.2" };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  logger: false;
  debug: false;
};

/**
 * Connects to the pre-resolved address to prevent DNS rebinding, while `tls.servername` keeps
 * certificate validation and SNI bound to the configured hostname.
 */
export function buildSmtpTransportOptions(
  config: Pick<OrganizationSmtpTransportConfig, "host" | "port" | "security" | "username" | "password">,
  pinnedAddress: string
): SmtpTransportOptions {
  const { host, port, security, username, password } = config;

  return {
    host: pinnedAddress,
    port,
    secure: security === "SSL",
    requireTLS: security === "STARTTLS",
    ignoreTLS: security === "NONE",
    ...(username && password ? { auth: { user: username, pass: password } } : {}),
    // Node rejects IP literals as SNI names, so servername is only sent for hostnames.
    tls: { ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    logger: false,
    debug: false,
  };
}
