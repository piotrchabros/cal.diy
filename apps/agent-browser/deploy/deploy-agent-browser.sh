#!/bin/bash
# Builds the agent browser image from a release checkout and restarts caldiy-agent-browser.service.
#
# Usage: deploy-agent-browser.sh [release-dir] [--force]
#   release-dir  a checkout with node_modules installed (default: the release of the active web slot)
#   --force      restart even when browser sessions are live
#
# A restart drops every open page, so while /healthz reports live sessions the new image is only tagged
# :next and the restart is deferred (exit 0). Run again later, or with --force, to apply it.
set -euo pipefail

IMAGE=caldiy-agent-browser
UNIT=caldiy-agent-browser
HEALTHZ=http://127.0.0.1:4410/healthz
SLOTS=/opt/caldiy/slots
KEEP_IMAGES=3
HEALTH_TIMEOUT_SECONDS=60

log() { echo "$(date -u +%T) agent-browser: $*"; }
fail() {
  log "FAILED: $*"
  exit 1
}

usage() {
  echo "usage: $0 [release-dir] [--force]" >&2
  exit 2
}

FORCE=0
SRC=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [ -z "$SRC" ] || usage
      SRC=$arg
      ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "must run as root (docker and systemctl)"

# fd 8, because caldiy-deploy.sh holds its own lock on fd 9 when it calls this script.
exec 8> /run/caldiy-agent-browser-deploy.lock
flock -n 8 || fail "another agent-browser deploy is running"

active_release() {
  local port
  for port in 3221 3222; do
    if systemctl is-active --quiet "caldiy@$port"; then
      readlink -f "$SLOTS/$port"
      return
    fi
  done
}

live_sessions() {
  local body
  # An unreachable service has no sessions to lose.
  body=$(curl -s --max-time 5 "$HEALTHZ") || {
    echo 0
    return
  }
  jq -r '.sessions // 0' <<< "$body" 2> /dev/null || echo 0
}

wait_healthy() {
  local deadline=$(($(date +%s) + HEALTH_TIMEOUT_SECONDS))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTHZ")" = 200 ] && return 0
    sleep 2
  done
  return 1
}

image_id() {
  docker image inspect --format '{{.Id}}' "$1" 2> /dev/null || true
}

prune_images() {
  local current_id count=0 tag id
  current_id=$(image_id "$IMAGE:current")
  # docker image ls lists newest first.
  while read -r tag id; do
    case "$tag" in current | next | "<none>") continue ;; esac
    count=$((count + 1))
    [ "$count" -le "$KEEP_IMAGES" ] && continue
    [ "$id" = "$current_id" ] && continue
    docker image rm "$IMAGE:$tag" > /dev/null 2>&1 || true
  done < <(docker image ls "$IMAGE" --no-trunc --format '{{.Tag}} {{.ID}}')
}

if [ -z "$SRC" ]; then
  SRC=$(active_release)
  [ -n "$SRC" ] || fail "no active caldiy@3221/3222 slot; pass a release dir"
fi
[ -d "$SRC/apps/agent-browser" ] || fail "$SRC has no apps/agent-browser"
SRC=$(readlink -f "$SRC")
SHA=$(git -C "$SRC" rev-parse --short HEAD) || fail "$SRC is not a git checkout"

log "building dist in $SRC ($SHA)"
(cd "$SRC" && yarn workspace @calcom/agent-browser build) || fail "yarn build failed"

log "building image $IMAGE:$SHA"
docker build -q -f "$SRC/apps/agent-browser/Dockerfile" -t "$IMAGE:$SHA" "$SRC/apps/agent-browser" > /dev/null ||
  fail "docker build failed"

new_id=$(image_id "$IMAGE:$SHA")
if [ "$new_id" = "$(image_id "$IMAGE:current")" ] && systemctl is-active --quiet "$UNIT"; then
  log "$IMAGE:current is already $SHA; nothing to do"
  exit 0
fi

sessions=$(live_sessions)
if [ "$sessions" -gt 0 ] 2> /dev/null && [ "$FORCE" -eq 0 ]; then
  docker tag "$IMAGE:$SHA" "$IMAGE:next"
  log "deferred: $sessions live sessions; tagged $IMAGE:next, rerun later or with --force"
  exit 0
fi

docker tag "$IMAGE:$SHA" "$IMAGE:current"
docker image rm "$IMAGE:next" > /dev/null 2>&1 || true
log "restarting $UNIT on $SHA"
systemctl reset-failed "$UNIT" 2> /dev/null || true
systemctl restart "$UNIT"
wait_healthy || fail "$UNIT did not answer $HEALTHZ within ${HEALTH_TIMEOUT_SECONDS}s (journalctl -u $UNIT)"
prune_images
log "live on $SHA"
