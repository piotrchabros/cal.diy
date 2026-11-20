# Built from the prebuilt bundle, so there is no monorepo install inside Docker. Run
# `yarn workspace @calcom/agent-browser build` first; deploy/deploy-agent-browser.sh does both:
#   docker build -f apps/agent-browser/Dockerfile -t caldiy-agent-browser:<sha> apps/agent-browser
# BuildKit reads Dockerfile.dockerignore next to this file, which lets only dist/ into the context.

# The browser revisions in this image must match the playwright npm version below, so both move together.
FROM mcr.microsoft.com/playwright:v1.57.0-noble@sha256:3bed4b1a12f2338642f3d8cba28e291deef3c66bd4a964bbeb3e57bbff511dbd

# The Chromium sandbox cannot start in a container on this host: AppArmor restricts unprivileged user
# namespaces, and root without --no-sandbox is refused. The container hardening in
# deploy/caldiy-agent-browser.service and the egress firewall are the boundary instead.
ENV NODE_ENV=production \
    AGENT_BROWSER_CHROMIUM_SANDBOX=false
WORKDIR /app
# The bundle leaves exactly these modules external (see the build script in package.json).
RUN npm init -y > /dev/null \
  && npm install --omit=dev --no-audit --no-fund playwright@1.57.0 ws@8.18.3 \
  && npm cache clean --force
COPY dist ./dist
USER pwuser
EXPOSE 4410 4411
CMD ["node", "dist/main.js"]
