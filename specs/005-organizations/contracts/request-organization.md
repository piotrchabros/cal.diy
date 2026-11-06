# Contract: request → organization → base URL

## Host resolution (`apps/web/proxy.ts`)

The proxy runs on every page and API request, except `/_next/*` and static assets.

1. It deletes the incoming `x-cal-org-id` and `x-cal-org-slug` request headers. They are only trusted when set here.
2. It normalises the host from `Host`: lowercase, port stripped. Caddy forwards the original host.
3. It resolves the host to an organization:
   - When `ORGANIZATIONS_ENABLED` is off, every host resolves to the default org. Behaviour is unchanged.
   - A loopback host (`localhost`, `127.0.0.1`, `::1`) resolves to the default org. This keeps the deploy health check and local development working.
   - Otherwise it uses `OrganizationSettings.customDomain = host` (60-second in-memory cache).
   - When the host is unknown, the response is `404` with a plain body, no organization content and no redirect.
4. It sets `x-cal-org-id` and `x-cal-org-slug` on the forwarded request.

## Reading it (server)

```ts
getOrgFromRequest(headers: Headers): Promise<{ id: number; slug: string; domain: string | null; isDefault: boolean }>
```

This helper reads the trusted headers. When they are absent (routes outside the proxy matcher, such as `pages/api/*`), it resolves from `Host` with the same rules. Every `currentOrgDomain = null` stub is replaced by this helper.

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
- `AUTH_TRUST_HOST=true`.
- In the `signIn` callback: when `user.organizationId != H`, sign-in is refused with error `wrong_organization_domain`, and the login page redirects to `https://<user's org domain>/auth/login`.
- The `redirect` callback and `getSafeRedirectUrl` allow `WEBAPP_URL`, `WEBSITE_URL`, `CONSOLE_URL`, and every org `customDomain`.

## App OAuth (calendar, video, CRM apps)

```ts
getOAuthRedirectUri(req, appSlug): string   // "https://<request org domain>/api/integrations/<appSlug>/callback"
```

It replaces `${WEBAPP_URL_FOR_OAUTH}/api/integrations/<app>/callback` in the add and callback handlers. Each domain's callback must be registered with each provider ([infra-owner-checklist.md](./infra-owner-checklist.md)).
