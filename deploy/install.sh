#!/usr/bin/env bash
# Antlings installer. Idempotent. Run as root on the VPS.
#
#   sudo ./install.sh --release antlings-0.1.0.tar.gz [--domain ants.example.com] [--dry-run]
#
# What it does, in order (each step prints what it does):
#   1. checks free memory (refuses under 600 MB), root, Node, systemd
#   2. creates the unprivileged user `antlings` (no sudo, no extra groups)
#   3. creates /opt/antlings, /var/lib/antlings, /etc/antlings, and a backup folder
#   4. unpacks the release into /opt/antlings/releases/<id> and switches the `current` link
#   5. writes /etc/antlings/antlings.env once, with generated secrets (mode 640, never printed)
#   6. installs the `antlings` command, the systemd unit, the fail2ban filter and jail
#   7. with --domain: writes /etc/caddy/antlings.caddy as a separate file and, when the main Caddyfile
#      already imports it, validates the config and reloads Caddy
#   8. starts the service and checks /health on 127.0.0.1
#
# It never touches ufw, Postgres, Redis, other services, sudoers, or the main Caddyfile.
# Every file it replaces is copied to /var/backups/antlings-<date> first. uninstall.sh reverses it.
set -euo pipefail

APP_USER=antlings
INSTALL_DIR=/opt/antlings
DATA_DIR=/var/lib/antlings
ETC_DIR=/etc/antlings
ENV_FILE=$ETC_DIR/antlings.env
UNIT=/etc/systemd/system/antlings.service
BIN=/usr/local/bin/antlings
CADDY_FILE=/etc/caddy/antlings.caddy
CADDY_MAIN=/etc/caddy/Caddyfile
F2B_FILTER=/etc/fail2ban/filter.d/antlings.conf
F2B_JAIL=/etc/fail2ban/jail.d/antlings.local
PORT=3100
MIN_FREE_MB=600
BACKUP_DIR=/var/backups/antlings-$(date +%F)
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

DRY=0
RELEASE=""
DOMAIN=""
SKIP_DNS=0

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --release) RELEASE=${2:?--release needs a file}; shift ;;
    --domain) DOMAIN=${2:?--domain needs a name}; shift ;;
    --skip-dns-check) SKIP_DNS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

# Runs a command, or only prints it in a dry run.
run() {
  if [ "$DRY" -eq 1 ]; then printf '    [dry-run] %s\n' "$*"; else printf '    + %s\n' "$*"; "$@"; fi
}

# Copies a file the first time and whenever it differs, after backing up the old one.
install_file() { # src dest mode owner:group
  local src=$1 dest=$2 mode=$3 owner=$4
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then note "unchanged: $dest"; return 0; fi
  if [ -e "$dest" ]; then
    run mkdir -p "$BACKUP_DIR"
    run cp -a "$dest" "$BACKUP_DIR/$(echo "$dest" | tr / _)"
  fi
  run install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dest"
}

# ---------------------------------------------------------------- 1. checks
step "Checking the machine"
if [ "$(id -u)" -ne 0 ]; then
  if [ "$DRY" -eq 1 ]; then note "not root: continuing because this is a dry run"; else die "run as root (sudo)"; fi
fi

if [ -r /proc/meminfo ]; then
  avail_mb=$(awk '/MemAvailable/ {printf "%d", $2 / 1024}' /proc/meminfo)
  if [ -z "$avail_mb" ]; then
    if [ "$DRY" -eq 1 ]; then note "MemAvailable not reported here: memory check skipped in this dry run"; else die "cannot read MemAvailable"; fi
  else
    note "available memory: ${avail_mb} MB (needs at least ${MIN_FREE_MB} MB)"
    if [ "$avail_mb" -lt "$MIN_FREE_MB" ]; then die "only ${avail_mb} MB free. Free memory first, nothing was changed."; fi
  fi
else
  if [ "$DRY" -eq 1 ]; then note "no /proc/meminfo here: memory check skipped in this dry run"; else die "cannot read /proc/meminfo"; fi
fi

NODE_BIN=/usr/bin/node
if command -v node >/dev/null 2>&1; then
  NODE_BIN=$(command -v node)
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  note "node $(node -v) at $NODE_BIN"
  [ "$node_major" -ge 22 ] || die "Node 22 or newer is required"
  case "$NODE_BIN" in
    /home/*|/root/*) die "node is installed under a home folder ($NODE_BIN). Install Node system-wide so the antlings user can run it." ;;
  esac
else
  if [ "$DRY" -eq 1 ]; then note "node not found here: skipped in this dry run"; else die "node is not installed"; fi
fi

if ! command -v systemctl >/dev/null 2>&1; then
  if [ "$DRY" -eq 1 ]; then note "systemctl not found here: skipped in this dry run"; else die "systemd is required"; fi
fi

if [ -n "$RELEASE" ]; then
  [ -f "$RELEASE" ] || { if [ "$DRY" -eq 1 ]; then note "release file not found: $RELEASE (dry run)"; else die "release file not found: $RELEASE"; fi; }
else
  if [ "$DRY" -eq 1 ]; then note "no --release given (dry run)"; else die "--release <file.tar.gz> is required"; fi
fi
note "backups go to $BACKUP_DIR"

# ---------------------------------------------------------------- 2. user
step "Service user"
if id "$APP_USER" >/dev/null 2>&1; then
  note "user $APP_USER exists"
else
  run useradd --create-home --home-dir "/home/$APP_USER" --shell /bin/bash --user-group "$APP_USER"
fi
if id -nG "$APP_USER" 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|wheel|admin|root|docker'; then
  die "$APP_USER is in a privileged group. Remove it from sudo, wheel, admin or docker first."
fi

# ---------------------------------------------------------------- 3. folders
step "Folders"
run install -d -m 755 "$INSTALL_DIR" "$INSTALL_DIR/releases"
run install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
run install -d -m 750 -o root -g "$APP_USER" "$ETC_DIR"
run install -d -m 755 "$(dirname "$BACKUP_DIR")"

# ---------------------------------------------------------------- 4. release
step "Release"
if [ -n "$RELEASE" ]; then
  id_=$(basename "$RELEASE" .tar.gz)
  target=$INSTALL_DIR/releases/$id_
  if [ -d "$target" ]; then
    note "release $id_ is already unpacked"
  else
    run mkdir -p "$target"
    run tar -xzf "$RELEASE" -C "$target"
    # Code is owned by root, so the agent (running as $APP_USER) cannot change it.
    run chown -R root:root "$target"
  fi
  if [ -L "$INSTALL_DIR/current" ]; then
    prev=$(readlink "$INSTALL_DIR/current")
    if [ "$prev" != "$target" ]; then run ln -sfn "$prev" "$INSTALL_DIR/previous"; fi
  fi
  run ln -sfn "$target" "$INSTALL_DIR/current.new"
  run mv -T "$INSTALL_DIR/current.new" "$INSTALL_DIR/current"
else
  note "skipped (no release)"
fi

# ---------------------------------------------------------------- 5. env file
step "Settings file"
if [ -f "$ENV_FILE" ]; then
  note "$ENV_FILE exists and is left as it is"
else
  origin="http://localhost:$PORT"
  if [ -n "$DOMAIN" ]; then origin="https://$DOMAIN"; fi
  claude_path=$(command -v claude 2>/dev/null || true)
  if [ "$DRY" -eq 1 ]; then
    note "[dry-run] would write $ENV_FILE (mode 640, root:$APP_USER) with ANTLINGS_ORIGIN=$origin and generated secrets"
  else
    (
      umask 077
      {
        echo "# Antlings settings. Generated by install.sh. Keep this file private: it holds secrets."
        echo "ANTLINGS_ORIGIN=$origin"
        echo "ANTLINGS_HOST=127.0.0.1"
        echo "ANTLINGS_PORT=$PORT"
        echo "ANTLINGS_DATA_DIR=$DATA_DIR"
        echo "ANTLINGS_HOME=/home/$APP_USER"
        echo "ANTLINGS_STATIC_DIR=$INSTALL_DIR/current/web"
        if [ -n "$claude_path" ]; then echo "ANTLINGS_CLAUDE_PATH=$claude_path"; fi
        echo "ANTLINGS_AUTH_MODE=apikey"
        echo "ANTLINGS_MAX_SESSIONS=2"
        echo "ANTLINGS_MAX_SUBAGENTS=3"
        echo "# Set your API key on the next line, then: systemctl restart antlings"
        echo "# ANTHROPIC_API_KEY="
        "$NODE_BIN" "$INSTALL_DIR/current/app/dist/cli.js" gen-env
      } > "$ENV_FILE"
    )
    chown "root:$APP_USER" "$ENV_FILE"
    chmod 640 "$ENV_FILE"
    note "wrote $ENV_FILE (secrets generated, not shown)"
  fi
fi

# ---------------------------------------------------------------- 6. command, unit, fail2ban
step "Command and service"
wrapper=$(mktemp)
trap 'rm -f "$wrapper"' EXIT
printf '#!/bin/sh\nexec %s %s/current/app/dist/cli.js "$@"\n' "$NODE_BIN" "$INSTALL_DIR" > "$wrapper"
install_file "$wrapper" "$BIN" 755 root:root
unit_tmp=$(mktemp)
sed "s#^ExecStart=/usr/bin/node #ExecStart=$NODE_BIN #" "$HERE/antlings.service" > "$unit_tmp"
install_file "$unit_tmp" "$UNIT" 644 root:root
rm -f "$unit_tmp"
run systemctl daemon-reload
run systemctl enable antlings

step "fail2ban"
if [ -d /etc/fail2ban ]; then
  install_file "$HERE/fail2ban/filter.d/antlings.conf" "$F2B_FILTER" 644 root:root
  install_file "$HERE/fail2ban/jail.d/antlings.local" "$F2B_JAIL" 644 root:root
  if command -v fail2ban-client >/dev/null 2>&1 && systemctl is-active --quiet fail2ban 2>/dev/null; then run fail2ban-client reload; else note "fail2ban is not running: files installed, no reload"; fi
else
  note "fail2ban is not installed: skipped. Install it and run this script again to add the jail."
fi

# ---------------------------------------------------------------- 7. caddy
step "Caddy"
caddy_reload=0
if [ -z "$DOMAIN" ]; then
  note "no --domain: Caddy is not touched. The service listens on 127.0.0.1:$PORT only."
elif ! command -v caddy >/dev/null 2>&1; then
  note "caddy is not installed: skipped"
else
  dns_ok=1
  if [ "$SKIP_DNS" -eq 0 ]; then
    resolved=$(dig +short A "$DOMAIN" 2>/dev/null | tail -n 1 || true)
    if [ -z "$resolved" ]; then dns_ok=0; note "DNS: $DOMAIN does not resolve yet"
    elif ! ip -4 -o addr show 2>/dev/null | grep -qw "$resolved"; then dns_ok=0; note "DNS: $DOMAIN resolves to $resolved, which is not an address of this machine"; fi
  fi
  if [ "$dns_ok" -eq 0 ]; then
    note "Caddy is not touched. Point the DNS A record here, then run this script again (or add --skip-dns-check behind NAT)."
  else
    snippet=$(mktemp)
    sed "s/__DOMAIN__/$DOMAIN/g" "$HERE/Caddyfile.snippet" > "$snippet"
    if caddy list-modules 2>/dev/null | grep -q 'http.handlers.rate_limit'; then
      sed -i 's/^\t#RL /\t/' "$snippet"
      note "rate limit module found: request rate limit enabled for /api/auth and /api/setup"
    else
      note "rate limit module not found: only the app's own lockout applies"
    fi
    install_file "$snippet" "$CADDY_FILE" 644 root:root
    rm -f "$snippet"
    if grep -Eqs '^[[:space:]]*import[[:space:]]+(/etc/caddy/antlings\.caddy|/etc/caddy/\*\.caddy)' "$CADDY_MAIN"; then
      if [ "$DRY" -eq 1 ]; then note "[dry-run] caddy validate --config $CADDY_MAIN, then systemctl reload caddy"; else
        caddy validate --config "$CADDY_MAIN" || die "Caddy rejected the config. $CADDY_FILE was written; the main Caddyfile is untouched and Caddy was not reloaded."
        caddy_reload=1
      fi
    else
      note "Add this line to $CADDY_MAIN yourself, then validate and reload:"
      note "    import $CADDY_FILE"
      note "    caddy validate --config $CADDY_MAIN && systemctl reload caddy"
    fi
  fi
fi
if [ "$caddy_reload" -eq 1 ]; then run systemctl reload caddy; fi

# ---------------------------------------------------------------- 8. start
step "Start"
if [ -n "$RELEASE" ]; then
  run systemctl restart antlings
else
  run systemctl start antlings
fi
if [ "$DRY" -eq 0 ]; then
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" -eq 1 ]; then note "health check passed on 127.0.0.1:$PORT"; else
    note "the service did not answer /health. See: journalctl -u antlings -n 50"
    exit 1
  fi
  systemctl show antlings -p MemoryCurrent | sed 's/^/    /'
fi

step "Next steps (you do these, nothing here did)"
note "1. Sign Claude Code in as the service user, or set ANTHROPIC_API_KEY in $ENV_FILE:"
note "     sudo -u $APP_USER -H claude login"
note "2. Print the one-time setup code:   sudo -u $APP_USER antlings setup"
note "3. Open the site and register your passkey (the code works for 15 minutes)."
if [ "$DRY" -eq 1 ]; then note "This was a dry run. Nothing was changed."; fi
exit 0
