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
VERSION=$(grep -m1 '"version"' "$ROOT/package.json" | cut -d'"' -f4)
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
    npm install -g pnpm@9.15.9 2>&1 | tail -2
    mkdir /w && cd /src
    tar --exclude=node_modules --exclude=dist --exclude=dist-release --exclude=.git --exclude=test-results -cf - . | tar -xf - -C /w
    cd /w
    # better-sqlite3 ships prebuilt Linux binaries. Scripts are skipped so no compiler is ever needed.
    pnpm install --frozen-lockfile --ignore-scripts 2>&1 | tail -3
    pnpm build
    pnpm --filter @antlings/server --prod deploy /pack/app >/dev/null
    mkdir -p /pack/rel/app /pack/rel/web /pack/rel/deploy
    cp -a /pack/app/. /pack/rel/app/
    # The VPS has its own claude binary (ANTLINGS_CLAUDE_PATH). The ~250 MB copies bundled with the SDK are not needed.
    rm -rf /pack/rel/app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-* /pack/rel/app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-* /pack/rel/app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-win32-*
    rm -rf /pack/rel/app/src /pack/rel/app/dist
    cp -a server/dist /pack/rel/app/dist
    cp -a web/dist/. /pack/rel/web/
    cp -a deploy/. /pack/rel/deploy/
    # pnpm leaves a few links that point back into the build folder. They are dangling on the VPS and the installer refuses them.
    find /pack/rel -type l -print0 | while IFS= read -r -d "" l; do
      case "$(readlink -m "$l")" in /pack/rel/*) ;; *) rm -f "$l" ;; esac
    done
    # Refuse to ship anything that looks like a secret or local data.
    if find /pack/rel \( -name ".env" -o -name ".env.*" -o -name "*.db" -o -name "*.pem" -o -name ".credentials*" \) -not -name ".env.example" | grep -q .; then
      echo "the release contains a secret-looking file" >&2; exit 1
    fi
    chmod -R go-w,u-s,g-s,a-t /pack/rel
    tar --owner=0 --group=0 --numeric-owner -czf "/out/$NAME.tar.gz" -C /pack/rel .
    (cd /out && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
    chmod 644 "/out/$NAME.tar.gz"
  '
echo "built $OUT/$NAME.tar.gz"
