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
STATE_DIR=/var/backups/antlings-state
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
if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -qE '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'; then
  die "--domain must be a plain host name such as ants.example.com"
fi

# Runs a command, or only prints it in a dry run.
run() {
  if [ "$DRY" -eq 1 ]; then printf '    [dry-run] %s\n' "$*"; else printf '    + %s\n' "$*"; "$@"; fi
}

# Copies a file the first time and whenever it differs, after backing up the old one.
install_file() { # src dest mode owner:group
  local src=$1 dest=$2 mode=$3 owner=$4
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then note "unchanged: $dest"; return 0; fi
  if [ -e "$dest" ]; then
    # Only a file that was not put there by this installer is worth keeping as the original.
    run mkdir -p "$BACKUP_DIR"
    if [ ! -e "$BACKUP_DIR/$(echo "$dest" | tr / _)" ]; then run cp -a "$dest" "$BACKUP_DIR/$(echo "$dest" | tr / _)"; fi
  else
    # uninstall.sh removes files listed here instead of restoring a backup
    run mkdir -p "$STATE_DIR"
    if [ "$DRY" -eq 0 ]; then echo "$dest" >> "$STATE_DIR/created.list"; fi
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
if id -nG "$APP_USER" 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|wheel|admin|root|docker|adm|lxd|disk|shadow|systemd-journal'; then
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
    # The tarball is checked before anything is extracted as root: no links, no absolute or ".." paths.
    if [ -f "$RELEASE" ]; then
      if [ -f "$RELEASE.sha256" ]; then
        note "checking $RELEASE.sha256"
        (cd "$(dirname "$RELEASE")" && sha256sum -c "$(basename "$RELEASE").sha256") || die "checksum does not match"
      else
        note "no $(basename "$RELEASE").sha256 next to the tarball: its origin is not checked"
      fi
      if tar -tzvf "$RELEASE" | grep -qE '^[lh]'; then die "the release contains links; refusing to extract it"; fi
      if tar -tzf "$RELEASE" | grep -qE '(^/|(^|/)\.\.(/|$))'; then die "the release contains absolute or .. paths; refusing to extract it"; fi
    fi
    # Extract into a temporary folder, fix modes, then move into place, so a failed extraction never looks installed.
    run rm -rf "$target.tmp"
    run mkdir -p "$target.tmp"
    run tar -xzf "$RELEASE" --no-same-owner --no-same-permissions -C "$target.tmp"
    run chown -R root:root "$target.tmp"
    # Nothing in the code tree may be writable by the antlings user (the agent) or carry setuid bits.
    run chmod -R go-w,u-s,g-s,a-t "$target.tmp"
    run mv -T "$target.tmp" "$target"
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
origin="http://localhost:$PORT"
if [ -n "$DOMAIN" ]; then origin="https://$DOMAIN"; fi
if [ -f "$ENV_FILE" ]; then
  note "$ENV_FILE exists and is left as it is"
  if ! grep -qx "ANTLINGS_ORIGIN=$origin" "$ENV_FILE"; then
    note "WARNING: ANTLINGS_ORIGIN in the file differs from $origin."
    note "         Browsers on another origin are refused. Edit the line and restart antlings if the address changed."
  fi
else
  claude_path=$(command -v claude 2>/dev/null || true)
  if [ "$DRY" -eq 1 ]; then
    note "[dry-run] would write $ENV_FILE (mode 640, root:$APP_USER) with ANTLINGS_ORIGIN=$origin and generated secrets"
  else
    env_tmp=$(mktemp "$ETC_DIR/.env.XXXXXX")
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
        echo "# Set a dedicated API key with a spend cap on the next line, then: systemctl restart antlings"
        echo "# ANTHROPIC_API_KEY="
        "$NODE_BIN" "$INSTALL_DIR/current/app/dist/cli.js" gen-env
      } > "$env_tmp"
    ) || { rm -f "$env_tmp"; die "could not generate the settings file"; }
    grep -q '^ANTLINGS_SECRET_KEY=' "$env_tmp" || { rm -f "$env_tmp"; die "generated settings have no secret key"; }
    chown "root:$APP_USER" "$env_tmp"
    chmod 640 "$env_tmp"
    mv -T "$env_tmp" "$ENV_FILE"
    note "wrote $ENV_FILE (secrets generated, not shown)"
  fi
fi

# ---------------------------------------------------------------- 6. command, unit, fail2ban
step "No ssh login for the service user"
if [ -d /etc/ssh/sshd_config.d ]; then
  sshd_tmp=$(mktemp)
  printf '# Antlings: the service user (and the agent that runs as it) must not log in over ssh.\nDenyUsers %s\n' "$APP_USER" > "$sshd_tmp"
  install_file "$sshd_tmp" /etc/ssh/sshd_config.d/antlings.conf 644 root:root
  rm -f "$sshd_tmp"
  note "reload sshd yourself when convenient: systemctl reload ssh   (not done here, to keep your session safe)"
else
  note "no /etc/ssh/sshd_config.d: skipped. Make sure $APP_USER cannot log in over ssh."
fi

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
  if command -v fail2ban-client >/dev/null 2>&1 && systemctl is-active --quiet fail2ban 2>/dev/null; then
    if [ "$DRY" -eq 1 ]; then note "[dry-run] fail2ban-client reload"; elif ! fail2ban-client reload; then
      note "WARNING: fail2ban could not reload. The Antlings jail may be wrong (needs python-systemd for backend=systemd). Other jails are unchanged."
    fi
  else note "fail2ban is not running: files installed, no reload"; fi
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
    if ! command -v dig >/dev/null 2>&1; then
      dns_ok=0; note "dig is not installed, so DNS cannot be checked"
    else
      resolved=$(dig +short A -- "$DOMAIN" 2>/dev/null | grep -E '^[0-9.]+$' || true)
      if [ -z "$resolved" ]; then dns_ok=0; note "DNS: $DOMAIN does not resolve yet"
      else
        dns_ok=0
        for ip4 in $resolved; do
          if ip -4 -o addr show 2>/dev/null | grep -qw "$ip4"; then dns_ok=1; fi
        done
        if [ "$dns_ok" -eq 0 ]; then note "DNS: $DOMAIN resolves to $(echo "$resolved" | tr '\n' ' '), none is an address of this machine"; fi
      fi
    fi
  fi
  if [ "$dns_ok" -eq 0 ]; then
    note "Caddy is not touched. Point the DNS A record here, then run this script again (or add --skip-dns-check behind NAT)."
  else
    snippet=$(mktemp)
    sed "s/__DOMAIN__/$DOMAIN/g" "$HERE/Caddyfile.snippet" > "$snippet"
    # The optional rate limit block stays commented. It needs the caddy-ratelimit module and an `order` line
    # in the global options, so it is enabled by hand (see the runbook).
    caddy_had_old=0
    if [ -e "$CADDY_FILE" ]; then caddy_had_old=1; fi
    install_file "$snippet" "$CADDY_FILE" 644 root:root
    rm -f "$snippet"
    if grep -Eqs '^[[:space:]]*import[[:space:]]+(/etc/caddy/antlings\.caddy|/etc/caddy/\*\.caddy)' "$CADDY_MAIN"; then
      if [ "$DRY" -eq 1 ]; then note "[dry-run] caddy validate --config $CADDY_MAIN, then systemctl reload caddy"; else
        if ! caddy validate --config "$CADDY_MAIN"; then
          # The main Caddyfile already imports this file. Leaving a broken one would break every site on the next reload.
          if [ "$caddy_had_old" -eq 1 ] && [ -f "$BACKUP_DIR/$(echo "$CADDY_FILE" | tr / _)" ]; then
            cp -a "$BACKUP_DIR/$(echo "$CADDY_FILE" | tr / _)" "$CADDY_FILE"
          else
            rm -f "$CADDY_FILE"
          fi
          die "Caddy rejected the config. $CADDY_FILE was put back as it was; Caddy was not reloaded."
        fi
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
  note "restarting the service ends running Claude Code sessions. They resume on the next message."
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
    if [ -n "$RELEASE" ] && [ -L "$INSTALL_DIR/previous" ]; then
      note "rolling back to the previous release"
      ln -sfn "$(readlink "$INSTALL_DIR/previous")" "$INSTALL_DIR/current.new"
      mv -T "$INSTALL_DIR/current.new" "$INSTALL_DIR/current"
      systemctl restart antlings || true
    fi
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
