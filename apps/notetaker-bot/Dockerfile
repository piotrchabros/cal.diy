# UNVERIFIED AGAINST THE REAL SERVICE (image build): written from documentation and memory and
# exercised only against fakes. Run the manual check in docs/deployment.md and record the result in
# docs/verification-status.md before relying on it, then remove this notice.
# This file was not built by its authors: no instruction below has been executed.
#
# Build from the repository root with BuildKit, which reads Dockerfile.dockerignore next to this file:
#   docker build --platform linux/amd64 -f apps/notetaker-bot/Dockerfile -t <image> .

FROM node:20-bookworm AS build
WORKDIR /repo
COPY . .
# skip-build: the root postinstall generates the Prisma client and app-store files, which the bot bundle does not use.
RUN yarn install --immutable --mode=skip-build
RUN yarn workspace @calcom/notetaker-bot build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DISPLAY=:99
WORKDIR /app
# The bundle leaves exactly these modules external (see the build script in package.json).
RUN npm init -y > /dev/null \
  && npm install --omit=dev --no-audit --no-fund playwright@1.57.0 ws@8.18.3
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb \
  && npx playwright install --with-deps chrome \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /tmp/.X11-unix \
  && chmod 1777 /tmp/.X11-unix
COPY --from=build /repo/apps/notetaker-bot/dist ./dist
USER node
# node must be PID 1: the launcher stops a runner with SIGTERM, and xvfb-run would neither forward it nor exit.
ENTRYPOINT ["/bin/sh", "-c", "Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 & tries=0; while [ ! -S /tmp/.X11-unix/X99 ] && [ \"$tries\" -lt 50 ]; do sleep 0.1; tries=$((tries + 1)); done; exec node \"$@\"", "notetaker-entrypoint"]
CMD ["dist/runnerMain.js"]
