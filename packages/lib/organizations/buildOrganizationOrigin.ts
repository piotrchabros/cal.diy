import { WEBAPP_URL } from "@calcom/lib/constants";

// Organization domains are served on the webapp's scheme and port (https without a port in production,
// http on the dev port in the local multi-domain setup), so links must not hardcode https.
export function buildOrganizationOrigin(domain: string, webappUrl: string = WEBAPP_URL): string {
  const { protocol, port } = new URL(webappUrl);
  return `${protocol}//${domain}${port ? `:${port}` : ""}`;
}
