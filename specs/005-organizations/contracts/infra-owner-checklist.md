# Owner checklist: infrastructure and third parties

These steps are done by the owner outside the repository. A domain works only after all of its rows are done.
The order of the whole rollout is in [quickstart.md §5](../quickstart.md#5-production-rollout-owner).

## Per organization domain (`cal.bespokesoft.pl`, `cal.jellymatch.tech`)

| Step | Where | Detail |
|------|-------|--------|
| DNS | registrar for `bespokesoft.pl` / `jellymatch.tech` | `A` (and `AAAA` if used) record `cal` → this server's IP. Check with `dig +short cal.bespokesoft.pl` before the Caddy step, otherwise Caddy cannot get a certificate |
| Caddy site | `/etc/caddy/Caddyfile` | a site block for the domain with the same `reverse_proxy` targets and health check as the `cal.bluebee.marketing` block (`127.0.0.1:3221`, `:3222`, `lb_policy first`); Caddy obtains the certificate. Do not add `header Cache-Control` or any caching for these sites (see "Move redirects" below). `caddy validate` then `systemctl reload caddy` |
| `ALLOWED_HOSTNAMES` | `/root/cal.diy/.env` | add `"cal.bespokesoft.pl","cal.jellymatch.tech"` (quoted, comma-separated, no scheme). Hosts that are not listed get the default organization's links and the default OAuth callback |
| OAuth callbacks | each provider's console | register this domain's callbacks for every app in use, see "OAuth apps" below. Do this before the host is added to `ALLOWED_HOSTNAMES`, otherwise connecting that app from the domain fails at the provider |
| App record | admin area → Organizations | the organization's domain is set to exactly this host (no scheme, no port) |
| Smoke test | browser / `curl` | `curl -sI https://<domain>/auth/login` answers 200 with a valid certificate |

## Once, before turning on `ORGANIZATIONS_ENABLED`

| Step | Where | Detail |
|------|-------|--------|
| Env | `/root/cal.diy/.env` (copied into releases) | `ORGANIZATIONS_ENABLED=1`, `AUTH_TRUST_HOST=true`; leave `NEXTAUTH_COOKIE_DOMAIN` empty, so each domain gets its own session cookie; `ALLOWED_HOSTNAMES` lists every organization host (above) |
| Forwarded headers | `/etc/caddy/Caddyfile`, firewall | next-auth trusts `X-Forwarded-Host` / `X-Forwarded-Proto` once `AUTH_TRUST_HOST` is set. Caddy must overwrite these headers, not pass on the client's values (the `reverse_proxy` default; do not add `trusted_proxies` or `header_up X-Forwarded-*` copying client values). The Node ports (`3221`, `3222`) must not be reachable from outside, only through Caddy: check from another machine that `curl --max-time 5 http://<server IP>:3221` fails, and that `ss -ltnp` shows them on `127.0.0.1` only or the firewall drops them |
| `AUTH_TRUST_HOST` | `/root/cal.diy/.env` | set only together with `ORGANIZATIONS_ENABLED`. While the flag is off, leave it unset; when the flag is turned off again, remove it too. Without the flag, the app has a single host and must not trust forwarded host headers |
| Migrations | `yarn workspace @calcom/prisma db-deploy` | in this order: (1) PR 1 (`customDomain`), (2) T061 / PR 22 (`20261107000100_organizations_bluebee_switchover`, BlueBee switch-over; compare the printed counts), (3) deploy, (4) only after the rollout is verified: T062 / PR 23 (`organizationId NOT NULL`). Each migration is applied before the deploy that needs it. The T221 code (flag-off user/team lookups ignore the organization, PR #297) is already on `develop`; deploy it before applying T061, then T061 can run while the flag is still off and public booking pages keep working. The follow-up flag-off fixes (T260–T262 and the sweep: #329 SMS lock, #330 booking access, #331 profiles, #332 team views, #333 event-type editing, plus the API v2 PR) must also be deployed before T061 is applied; #330 in particular stops every logged-in user from opening every personal booking once all owners belong to BlueBee. T062's migration is written to abort while any user still has no organization. T062 ships as stacked draft PRs #346 → #347 → #348: merge them back to back only after step 4's verification. From #346 on, every deploy needs `db-deploy` first (the code then requires the default organization, and #346 carries the migration) |

## Move redirects (T102)

Moving a user or team (FR-005) leaves a **308 Permanent Redirect** from the old domain to the new one (FR-018). When the old organization later reuses the freed username or slug, the redirect is disabled (US5-6). Browsers cache 308s unless told otherwise, so a cached redirect would keep sending visitors to the moved person instead of the new owner of the name.

The booking pages that send these redirects (`[user]`, `[user]/[type]`, `team/[slug]`, `team/[slug]/[type]`, `d/[link]/[slug]` and their `embed` variants) are rendered dynamically, and Next.js sends `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` on those responses, redirects included. With `no-store` the browser does not cache the redirect and asks again on every visit, so disabling a redirect takes effect at once. Therefore:

- Do not add a `Cache-Control`/`Expires` header or a cache in Caddy (or a CDN) for the app's sites.
- After the first move, check it once: `curl -sI https://cal.bluebee.marketing/<moved username>` must show `HTTP/2 308`, `location: https://<new domain>/<username>` and `cache-control: private, no-cache, no-store, max-age=0, must-revalidate`. If `cache-control` is missing or allows caching, stop moving people and report it (the fix is to send that header explicitly in `apps/web/lib/handleOrgRedirect.ts`).
- Search engines still treat a 308 as permanent and move the old URL's ranking to the new one; that is intended.

## OAuth apps: register each domain's callback

Only for apps actually used on this instance. The production list comes from this read-only query, run by the owner (quickstart step 0):

```sql
SELECT "appId", count(*) FROM "Credential" WHERE "appId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
SELECT slug FROM "App" WHERE enabled ORDER BY 1;
```

For every app below that the query returns, add the callback for **each** organization domain (`<domain>` = `cal.bespokesoft.pl`, `cal.jellymatch.tech`) next to the existing `cal.bluebee.marketing` one. The callback is built from the domain the user is on (`packages/app-store/_utils/oauth/getOAuthRedirectUri.ts`), and the OAuth state is checked against that domain's session cookie, so the default domain's callback is not enough.

| App (slug) | Provider console | Callback to add per domain |
|------------|------------------|----------------------------|
| Google Calendar / Meet (`googlecalendar`) | Google Cloud → APIs & Services → Credentials → OAuth client → Authorized redirect URIs | `https://<domain>/api/integrations/googlecalendar/callback` |
| Office 365 Calendar (`office365calendar`) | Azure portal → App registrations → Authentication → Web redirect URIs | `https://<domain>/api/integrations/office365calendar/callback` |
| Microsoft Teams (`office365video`) | same Azure app registration (or its own) | `https://<domain>/api/integrations/office365video/callback` |
| Zoom (`zoomvideo`) | Zoom Marketplace → app → OAuth redirect URL and allow list | `https://<domain>/api/integrations/zoomvideo/callback` |
| Webex (`webex`) | Webex developer portal → integration → Redirect URI(s) | `https://<domain>/api/integrations/webex/callback` |
| Stripe Connect (`stripepayment`) | Stripe dashboard → Connect → Settings → Redirects | `https://<domain>/api/integrations/stripepayment/callback` |
| Alby (`alby`) | Alby developer portal → OAuth client → Callback URL | `https://<domain>/apps/alby/setup?callback=true` (Alby's callback is the setup page, not `/api/integrations`; its webhook stays on `cal.bluebee.marketing`) |
| HubSpot, Salesforce, Pipedrive, Close, Zoho CRM / Bigin / Calendar, Intercom, Basecamp, Feishu, Lark, Huddle01, Tandem, Nextcloud Talk, Jelly, Lyra, Vital | each provider's app settings | `https://<domain>/api/integrations/<slug>/callback` with the slug `hubspot`, `salesforce`, `pipedrive-crm`, `closecom`, `zohocrm`, `zoho-bigin`, `zohocalendar`, `intercom`, `basecamp3`, `feishucalendar`, `larkcalendar`, `huddle01video`, `tandemvideo`, `nextcloudtalk`, `jelly`, `lyra`, `vital` |

Sign-in with Google or Microsoft starts on the domain the user is on (T210, research.md R6: one session per domain). If Google or Microsoft sign-in is enabled (`GOOGLE_LOGIN_ENABLED`, `OUTLOOK_LOGIN_ENABLED`), register `https://<domain>/api/auth/callback/google` (Google OAuth client) and `https://<domain>/api/auth/callback/azure-ad` (Azure app registration) for **every** organization domain, next to the existing `cal.bluebee.marketing` ones.

Until a domain is registered with a provider, members of that organization cannot connect that app. Existing connections keep working: tokens are not tied to the domain, and webhooks and token refreshes keep using `cal.bluebee.marketing`.

## Go-live sign-off

- [ ] DNS, Caddy, `ALLOWED_HOSTNAMES` and app record done for every organization domain
- [ ] OAuth callbacks registered for every app the step 0 query returns, per domain
- [ ] Node ports not reachable from outside; Caddy overwrites `X-Forwarded-*`
- [ ] PR 1 and T061 migrations applied, counts checked
- [ ] `ORGANIZATIONS_ENABLED=1` and `AUTH_TRUST_HOST=true` set together, deployed
- [ ] Quickstart S1, S5, S9, S10 pass on production; after the first move, the 308 check above passes
