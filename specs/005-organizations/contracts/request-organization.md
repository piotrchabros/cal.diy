# Contract: request → organization → base URL

## Host resolution (`apps/web/proxy.ts`)

The proxy runs on every page and API request, except `/_next/*` and static assets.

1. It deletes the incoming `x-cal-org-id`, `x-cal-org-slug`, `x-cal-org-domain` and `x-cal-org-default` request headers (`stripOrgHeaders`). They are only trusted when set here, so they are stripped on every route.
2. It normalises the host from `Host`: lowercase, port and trailing dot stripped. Caddy forwards the original host.
3. It resolves the host to an organization (`OrganizationDomainResolver`):
   - When `ORGANIZATIONS_ENABLED` is off, every host resolves to the default org. Behaviour is unchanged.
   - A loopback host (`localhost`, `127.0.0.1`, `::1`) resolves to the default org. This keeps the deploy health check and local development working.
   - Otherwise it uses `OrganizationSettings.customDomain = host`.
   - The default org is the one whose domain equals the host of `WEBAPP_URL`. When there is none, the result is `null`.
   - When the host is unknown, the response is `404` with a plain body, no organization content and no redirect.
4. It sets the headers on the forwarded request (`setOrgHeaders`):

| Header | Value |
|--------|-------|
| `x-cal-org-id` | org id, positive integer |
| `x-cal-org-slug` | org slug; omitted when the slug is `null` |
| `x-cal-org-domain` | org domain; omitted when the domain is `null` |
| `x-cal-org-default` | `"1"` for the default org, otherwise `"0"` |

The header names and `stripOrgHeaders` / `setOrgHeaders` / `readOrgFromHeaders` live in `packages/features/organizations/lib/orgRequestHeaders.ts`, which has no runtime imports so the proxy can import it statically.

### Resolver cache

`OrganizationDomainResolver` is a per-process singleton (DI container `getOrganizationDomainResolver()`) with an in-memory cache:

- Entries live 60 seconds (`ORGANIZATION_DOMAIN_CACHE_TTL_MS`). Keys are `domain:<host>` and `default:<defaultDomain>`.
- Misses (`null`) are cached too, so unknown hosts do not hit the database on every request.
- At most 1000 entries. When full, the oldest insertion is evicted. This bounds memory when clients send arbitrary `Host` values.
- Concurrent lookups of the same key share one query.
- Errors are never cached: the next request queries again.

## Reading it (server)

```ts
type RequestOrganizationDto = { id: number; slug: string | null; domain: string | null; isDefault: boolean };

getOrgFromRequest(headers: Pick<Headers, "get">): Promise<RequestOrganizationDto | null>
```

This helper reads the trusted headers. When they are absent or the id header is not a positive integer (routes outside the proxy matcher, such as `pages/api/*`), it resolves from `Host` with the same rules, loading the resolver lazily so callers with the headers never load Prisma. It returns `null` when no organization matches. Every `currentOrgDomain = null` stub is replaced by this helper.

## Base URL of a subject

```ts
OrganizationUrlService.getBaseUrl({ organizationId }): Promise<string>       // "https://cal.bespokesoft.pl"
OrganizationUrlService.getBaseUrlForUser({ userId }): Promise<string>
OrganizationUrlService.getBaseUrlForTeam({ teamId }): Promise<string>       // the team's parent org
```

- When the org has no domain, the result is `WEBAPP_URL`.
- Callers with a request use the request org. Callers without one (emails, workflows, reminders, crons, tasker) pass the subject.
- `CalendarEvent.bookerUrl` = the base URL of the organizer's org (the team's org for team events).

## Client

The root layout passes `{ baseUrl, orgSlug }` from the trusted headers to `OrgBaseUrlProvider`.

```ts
useOrgBaseUrl(): string            // replaces NEXT_PUBLIC_WEBAPP_URL / WEBAPP_URL in client link building
useBookerUrl(): string             // now = useOrgBaseUrl()
useEmbedBookerUrl(): string        // now = useOrgBaseUrl()
```

## Public pages on a host (`H` = the org resolved from the host)

| Path | Resolves | Not in `H` |
|------|----------|------------|
| `/<username>[/<event>]`, `/<u1>+<u2>` | users with `organizationId = H` | redirect (`TempOrgRedirect` from `H`) or 404 |
| `/team/<slug>[/<event>]` | team with `parentId = H` | redirect or 404 |
| `/d/<link>/<slug>` | hashed link whose owner or team is in `H` | 404 |
| `/booking/<uid>`, `/reschedule/<uid>`, cancel | booking whose organizer is in `H` | 308 to the same path on the organizer's org domain |
| `POST /api/book/event` | event type owned in `H` | refused, error `"event_not_found"` |

## Sign-in

- The session cookie is host-only (`NEXTAUTH_COOKIE_DOMAIN` stays empty).
- `AUTH_TRUST_HOST=true`, but only together with `ORGANIZATIONS_ENABLED`. While the flag is off, `AUTH_TRUST_HOST` stays unset, so next-auth keeps using `NEXTAUTH_URL` and ignores `X-Forwarded-Host`.
- The `signIn` callback runs the domain policy only after the user is authenticated:
  - credentials, including the 2FA step;
  - OAuth (Google, Azure AD);
  - the magic-link callback (when the link is opened). The magic-link request step (sending the email) does not run it.
- When `user.organizationId != H`, the callback redirects to `https://<user's org domain>/auth/login?reason=wrong_organization_domain`. The login page there shows a notice that this is the user's organization address. For credentials sign-in (`redirect: false`), the login page follows that URL with `window.location.assign`.
- When that redirect would loop (the user's org domain is the current host, or it can't be resolved), sign-in goes to `/auth/error?error=wrong_organization_domain`. On the login page, a `wrong_organization_domain` error shows the same message.
- There is no endpoint that looks up a domain from an email. The user's domain is only revealed after authentication, so the login page cannot be used to find out which emails have accounts.
- The `redirect` callback and `getSafeRedirectUrl` allow `WEBAPP_URL`, `WEBSITE_URL`, `CONSOLE_URL`, and every org `customDomain`.

## App OAuth (calendar, video, CRM apps)

```ts
getOAuthRedirectUri(req, appSlug): string   // "https://<request org domain>/api/integrations/<appSlug>/callback"
```

It replaces `${WEBAPP_URL_FOR_OAUTH}/api/integrations/<app>/callback` in the add and callback handlers. Each domain's callback must be registered with each provider ([infra-owner-checklist.md](./infra-owner-checklist.md)).
