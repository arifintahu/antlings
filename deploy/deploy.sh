#!/usr/bin/env bash
# One command: build the release, copy it to the server, install it, and check it from outside.
#
#   VPS_SSH=ubuntu@your-host DOMAIN=ants.example.com ./deploy/deploy.sh [--skip-dns-check]
#
# Needs Docker on this machine and key-based ssh with sudo on the server. The address is never stored in the
# repository. It runs install.sh on the server, so the same safety checks apply (checksum, link check,
# rollback when the new release does not answer /health).
set -euo pipefail

VPS_SSH=${VPS_SSH:?set VPS_SSH, for example ubuntu@your-host}
DOMAIN=${DOMAIN:-}
EXTRA=${1:-}
case "$EXTRA" in ""|--skip-dns-check) ;; *) echo "unknown option: $EXTRA" >&2; exit 2 ;; esac
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -qE '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'; then
  echo "DOMAIN must be a plain host name" >&2; exit 2
fi
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REMOTE_DIR=/root/antlings-release

echo "==> Building the release"
bash "$ROOT/deploy/build-release.sh" > /tmp/antlings-build.log 2>&1 || { tail -20 /tmp/antlings-build.log; exit 1; }
TAR=$(find "$ROOT/dist-release" -maxdepth 1 -name '*.tar.gz' -printf '%T@ %p
' | sort -n | tail -n 1 | cut -d' ' -f2-)
NAME=$(basename "$TAR")
echo "    $NAME ($(du -h "$TAR" | cut -f1)), sha256 $(cut -c1-12 "$TAR.sha256")..."

echo "==> Copying to the server"
scp -o BatchMode=yes "$TAR" "$TAR.sha256" "$VPS_SSH:/tmp/"

echo "==> Installing"
ARGS=(--release "$NAME")
if [ -n "$DOMAIN" ]; then ARGS+=(--domain "$DOMAIN"); fi
if [ -n "$EXTRA" ]; then ARGS+=("$EXTRA"); fi
# shellcheck disable=SC2029  # the values are expanded here on purpose; they were validated above
ssh -o BatchMode=yes "$VPS_SSH" "sudo install -d -m 700 $REMOTE_DIR && sudo mv /tmp/$NAME /tmp/$NAME.sha256 $REMOTE_DIR/ && sudo bash -c 'cd $REMOTE_DIR && tar -xzf $NAME ./deploy && ./deploy/install.sh ${ARGS[*]}'" \
  | grep -vE '^\{"level' | tail -25

if [ -n "$DOMAIN" ]; then
  echo "==> Checking https://$DOMAIN"
  for _ in $(seq 1 15); do
    if curl -fsS -m 10 "https://$DOMAIN/health" 2>/dev/null | grep -q '"ok":true'; then echo "    healthy"; exit 0; fi
    sleep 2
  done
  echo "    https://$DOMAIN/health did not answer in 30 s" >&2
  exit 1
fi
echo "    done (no DOMAIN given, so only the server-side check ran)"
