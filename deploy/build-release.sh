#!/usr/bin/env bash
# Builds the release tarball for Linux x64 inside a Node 24 container, so native modules
# (better-sqlite3, argon2) are the Linux builds and the VPS needs no compiler and no pnpm.
#
#   ./deploy/build-release.sh            -> dist-release/antlings-<version>.tar.gz
#
# The tarball contains: app/ (server code and production node_modules), web/ (built page), deploy/ (this folder).
# Needs Docker on the machine that builds. Runs nothing on the VPS.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
STAMP=$(date +%Y%m%d%H%M)
OUT=$ROOT/dist-release
NAME=antlings-$VERSION-$STAMP
mkdir -p "$OUT"

# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the container paths.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOT:/src:ro" -v "$OUT:/out" \
  -e NAME="$NAME" \
  node:24-slim bash -c '
    set -euo pipefail
    npm install -g pnpm@9.15.9 >/dev/null 2>&1
    mkdir /w && cd /src
    tar --exclude=node_modules --exclude=dist --exclude=dist-release --exclude=.git --exclude=test-results -cf - . | tar -xf - -C /w
    cd /w
    pnpm install --frozen-lockfile >/dev/null
    pnpm build
    pnpm --filter @antlings/server --prod deploy /pack/app >/dev/null
    mkdir -p /pack/rel/app /pack/rel/web /pack/rel/deploy
    cp -a /pack/app/. /pack/rel/app/
    cp -a server/dist /pack/rel/app/dist
    cp -a web/dist/. /pack/rel/web/
    cp -a deploy/. /pack/rel/deploy/
    tar -czf "/out/$NAME.tar.gz" -C /pack/rel .
    chmod 644 "/out/$NAME.tar.gz"
  '
echo "built $OUT/$NAME.tar.gz"
