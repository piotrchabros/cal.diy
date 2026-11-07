# Owner checklist: infrastructure and third parties

These steps are done by the owner outside the repository. A domain works only after all of its rows are done.

## Per organization domain (`cal.bespokesoft.pl`, `cal.jellymatch.tech`)

| Step | Where | Detail |
|------|-------|--------|
| DNS | registrar for `bespokesoft.pl` / `jellymatch.tech` | `A` (and `AAAA` if used) record `cal` → this server's IP |
| Caddy site | `/etc/caddy/Caddyfile` | a site block for the domain with the same `reverse_proxy` targets and health check as the `cal.bluebee.marketing` block (`127.0.0.1:3221`, `:3222`, `lb_policy first`); Caddy obtains the certificate |
| App record | admin area → Organizations | the organization's domain is set to exactly this host |

## Once, before turning on `ORGANIZATIONS_ENABLED`

| Step | Where | Detail |
|------|-------|--------|
| Env | `/root/cal.diy/.env` (copied into releases) | `ORGANIZATIONS_ENABLED=1`, `AUTH_TRUST_HOST=true`; leave `NEXTAUTH_COOKIE_DOMAIN` empty; add the new hosts to `ALLOWED_HOSTNAMES` |
| Forwarded headers | `/etc/caddy/Caddyfile`, firewall | next-auth trusts `X-Forwarded-Host` / `X-Forwarded-Proto` once `AUTH_TRUST_HOST` is set. Caddy must overwrite these headers, not pass on the client's values (the `reverse_proxy` default). The Node ports (`3221`, `3222`) must not be reachable from outside, only through Caddy |
| `AUTH_TRUST_HOST` | `/root/cal.diy/.env` | set only together with `ORGANIZATIONS_ENABLED`. While the flag is off, leave it unset; when the flag is turned off again, remove it too |
| Migrations | `yarn workspace @calcom/prisma db-deploy` | PR 1 (`customDomain`) and PR 22 (BlueBee switch-over), applied before the deploy that needs them; compare the printed counts. Deploy the T221 code (flag-off user/team lookups ignore the organization) before applying PR 22; with it, PR 22 can run while the flag is still off and public booking pages keep working. Without it, apply PR 22 and turn the flag on in the same window |

## OAuth providers: register each domain's callback

Only for providers actually used on this instance. To list them, run the "installed apps" query in [quickstart.md](../quickstart.md), step 0.

| Provider | Callback to add per domain |
|----------|----------------------------|
| Google (sign-in) | `https://<domain>/api/auth/callback/google` |
| Azure AD (sign-in) | `https://<domain>/api/auth/callback/azure-ad` |
| Google Calendar / Meet | `https://<domain>/api/integrations/googlecalendar/callback` |
| Office 365 Calendar / Teams | `https://<domain>/api/integrations/office365calendar/callback` (and `office365video`) |
| Zoom | `https://<domain>/api/integrations/zoomvideo/callback` (Zoom's allow-list) |
| Others | `https://<domain>/api/integrations/<app-slug>/callback` |

Until a domain is registered with a provider, members of that organization cannot connect that app. Existing connections keep working: tokens are not tied to the domain.
