#!/usr/bin/env bash
# Smoke test for a release tarball. Starts the service with a temporary data folder and checks it over HTTP.
# Runs on the machine where it is called (a Linux container locally, or the VPS over an SSH session).
#
#   deploy/smoke.sh antlings-0.1.0-<stamp>.tar.gz
#
# It needs node on the PATH and curl. It creates and deletes a folder under /tmp, starts one process on
# 127.0.0.1:3177, and stops it again. It never runs `antlings setup`, never registers a passkey.
set -euo pipefail

TAR=${1:?usage: smoke.sh <release.tar.gz>}
PORT=3177
ORIGIN=http://localhost:$PORT
WORK=$(mktemp -d /tmp/antlings-smoke-XXXXXX)
PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
check() { # description, expected, actual
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: expected '$2', got '$3'"; fi
}

tar -xzf "$TAR" -C "$WORK"
mkdir -p "$WORK/data" "$WORK/home/proj"

# Secrets come from the release's own generator and never go to the terminal.
node "$WORK/app/dist/cli.js" gen-env > "$WORK/gen.env"
set -a
# shellcheck disable=SC1091
. "$WORK/gen.env"
set +a
export ANTLINGS_ORIGIN=$ORIGIN ANTLINGS_PORT=$PORT ANTLINGS_HOST=127.0.0.1 ANTLINGS_DATA_DIR=$WORK/data
export ANTLINGS_HOME=$WORK/home ANTLINGS_STATIC_DIR=$WORK/web ANTLINGS_ENV_FILE=/nonexistent NODE_ENV=production NODE_OPTIONS=--max-semi-space-size=1

( cd "$WORK/app" && exec node dist/main.js ) > "$WORK/server.log" 2>&1 &
PID=$!

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
check "/health answers" '{"ok":true}' "$(curl -fsS "http://127.0.0.1:$PORT/health")"

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
B=http://127.0.0.1:$PORT

check "an API route without a session is 401" 401 "$(code "$B/api/sessions")"
check "an encoded API path without a session is 401" 401 "$(code "$B/%61pi/security")"
check "a POST without Origin is 403" 403 "$(code -X POST -H 'content-type: application/json' -d '{}' "$B/api/auth/password")"
check "the login page loads" 200 "$(code "$B/")"
check "first run is open" '"firstRun":true' "$(curl -fsS "$B/api/auth/status" | grep -o '"firstRun":[a-z]*')"
check "setup with a wrong code is refused" 403 "$(code -X POST -H "origin: $ORIGIN" -H 'content-type: application/json' -d '{"code":"ANT-AAAA-BBBB"}' "$B/api/setup/options")"

# WebSocket upgrade without Origin or ticket must be refused.
ws_status=$(curl -s -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$B/ws" || true)
check "websocket without Origin or ticket is refused" 403 "$ws_status"

H=$(curl -sI "$B/")
for h in content-security-policy x-content-type-options referrer-policy permissions-policy; do
  if printf '%s' "$H" | grep -qi "^$h:"; then pass "header $h present"; else fail "header $h missing"; fi
done
if printf '%s' "$H" | grep -qi "^access-control-allow-origin"; then fail "CORS header present"; else pass "no CORS header"; fi

rss_kb=$(awk '/VmRSS/ {print $2}' "/proc/$PID/status")
rss_mb=$((rss_kb / 1024))
printf 'info idle memory: %s MB resident\n' "$rss_mb"
if [ "$rss_mb" -lt 100 ]; then pass "idle memory under 100 MB"; else fail "idle memory is $rss_mb MB"; fi

if grep -qE 'password|secret|SECRET_KEY' "$WORK/server.log"; then fail "the log mentions a secret word"; else pass "log has no secrets"; fi
printf '\nsmoke test passed\n'
