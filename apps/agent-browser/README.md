# @calcom/agent-browser

A Playwright Chromium that the meeting agent drives during a Recall meeting, streamed to the meeting
as a screenshare. One browser context per Recall bot.

- Control API on `:4410` (Bearer `AGENT_BROWSER_SECRET`), published on host loopback only and never
  routed by Caddy. `GET /healthz` is unauthenticated and reports `sessions` and `viewers`.
- Viewer on `:4411` (`/agent-browser/view`, `/agent-browser/ws`, token in the URL), behind Caddy at
  `https://cal.bluebee.marketing/agent-browser/`.

The wire contract lives in `packages/lib/agentBrowser/contract.ts`.

## Commands

Run from the repository root.

| Command | What it does |
|---|---|
| `yarn workspace @calcom/agent-browser test` | Unit tests |
| `yarn workspace @calcom/agent-browser typecheck` | `tsc --noEmit` |
| `yarn workspace @calcom/agent-browser build` | Bundle into `dist/main.js` (`playwright` and `ws` external) |

## Runtime

The service runs in Docker as `caldiy-agent-browser.service`, independent of the web blue/green swap.

- Image: `mcr.microsoft.com/playwright:v1.57.0-noble`, pinned by digest, plus the prebuilt `dist/`.
  The playwright npm version and the image version must move together.
- No secrets in the image. The env file is `/etc/caldiy/agent-browser.env` (mode 600); see
  [deploy/agent-browser.env.example](deploy/agent-browser.env.example).
- **The Chromium sandbox is off** (`AGENT_BROWSER_CHROMIUM_SANDBOX=false`, set in the image). This host
  sets `kernel.apparmor_restrict_unprivileged_userns=1`: as root Chromium refuses to start without
  `--no-sandbox`, and as `pwuser` it finds no usable sandbox. The boundary is the container instead:
  `pwuser`, `--cap-drop ALL`, `no-new-privileges`, read-only root with tmpfs `/tmp` and `/home/pwuser`,
  8 GB memory, 6 CPUs, 2048 pids, default seccomp, ports on `127.0.0.1` only.
- **Egress** goes through the bridge `br-caldiy-ab` (network `caldiy-agent-browser`, `10.213.7.0/24`,
  no inter-container traffic, no IPv6). [deploy/firewall.sh](deploy/firewall.sh) keeps two chains:
  - `CALDIY-AB` in `DOCKER-USER` (forwarded traffic): replies, then REJECT for private, CGNAT
    (tailscale `100.83.210.112`), loopback, link-local (metadata), multicast, reserved ranges and every
    host address (public `169.58.224.192`); then allow tcp 80/443, udp 53/443 and tcp 53; reject the rest.
  - `CALDIY-AB-IN` in `INPUT` (traffic to the host itself): replies and tcp 80/443 to the public IP
    (Caddy, so `cal.bluebee.marketing` works); everything else, including `:3221`, `:3222`, `:22`,
    `:5432`, `:6767`, `:6769`, `:6770`, `:4410`, is rejected.

  The firewall unit runs after every docker start or restart, and the browser unit requires it.

## Deploying

`deploy/deploy-agent-browser.sh [release-dir] [--force]` (root) builds `dist/` in the release (default:
the release of the active web slot), builds `caldiy-agent-browser:<sha>`, tags it `:current`, restarts
the unit and waits for `/healthz`. While sessions are live it only tags `:next` and exits 0, because a
restart drops every open page. Run it again later, or with `--force`.

## Owner-run host steps (root)

From a checkout of this code, for example the active release in `/opt/caldiy/slots/<port>`.

1. Base image (already pulled on this host):
   `docker image inspect mcr.microsoft.com/playwright:v1.57.0-noble --format '{{json .RepoDigests}}'`
   must show the digest pinned in the Dockerfile.
2. Firewall:
   ```
   install -m 755 apps/agent-browser/deploy/firewall.sh /usr/local/sbin/caldiy-agent-browser-firewall.sh
   install -m 644 apps/agent-browser/deploy/caldiy-agent-browser-firewall.service apps/agent-browser/deploy/caldiy-agent-browser.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now caldiy-agent-browser-firewall
   iptables -S CALDIY-AB; iptables -S CALDIY-AB-IN; ip6tables -S INPUT | grep br-caldiy-ab
   ```
3. Secret:
   ```
   install -d -m 700 /etc/caldiy
   install -m 600 apps/agent-browser/deploy/agent-browser.env.example /etc/caldiy/agent-browser.env
   sed -i "s/^AGENT_BROWSER_SECRET=.*/AGENT_BROWSER_SECRET=$(openssl rand -hex 32)/" /etc/caldiy/agent-browser.env
   ```
4. First deploy and start:
   ```
   apps/agent-browser/deploy/deploy-agent-browser.sh "$PWD"
   systemctl enable caldiy-agent-browser
   curl -s 127.0.0.1:4410/healthz
   ```
5. Egress check. Each line must print `blocked` except the last two, which must print `OPEN`:
   ```
   for url in http://169.254.169.254 http://172.17.0.1:22 http://10.99.3.1 http://169.58.224.192:3221 \
     http://169.58.224.192:22 http://100.83.210.112:22 http://10.213.7.1:4410 \
     https://example.com https://cal.bluebee.marketing/api/version; do
     docker exec caldiy-agent-browser node -e "fetch('$url',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('OPEN',r.status,'$url')).catch(e=>console.log('blocked',e.cause?.code??e.name,'$url'))"
   done
   ```
6. Caddy: back up `/etc/caddy/Caddyfile`, add `handle /agent-browser/* { reverse_proxy 127.0.0.1:4411 }`
   ahead of the existing proxy inside a `handle` block, then
   `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`.
   `curl -sI https://cal.bluebee.marketing/agent-browser/view` must return 401.
7. Enable in the web app (`/root/cal.diy/.env`): `NOTETAKER_AGENT_BROWSER_ENABLED=1`,
   `AGENT_BROWSER_INTERNAL_URL=http://127.0.0.1:4410`,
   `AGENT_BROWSER_PUBLIC_URL=https://cal.bluebee.marketing/agent-browser` and the same
   `AGENT_BROWSER_SECRET`, then `/root/caldiy-deploy.sh`.
8. Optional: call `apps/agent-browser/deploy/deploy-agent-browser.sh "$REL" || log "agent-browser deploy failed (web unaffected)"`
   from `/root/caldiy-deploy.sh` after `switch_to`.

## Risks

- Any meeting participant can make the browser open any public site. Mitigated by the visible
  address bar, no cookies or logins, the egress firewall and the agent's command limits.
- A hostile page may try to steer the agent (prompt injection). Typed text is capped and navigations
  are logged by host only; it cannot be fully prevented.
- If something flushes iptables while the container runs, the firewall is gone until
  `systemctl restart caldiy-agent-browser-firewall`.
