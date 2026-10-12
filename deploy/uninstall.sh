#!/usr/bin/env bash
# Antlings uninstaller. Reverses install.sh. Run as root.
#
#   sudo ./uninstall.sh [--dry-run] [--purge]
#
# Removes the service, the command, the fail2ban files, the Caddy snippet and the program files.
# A file that install.sh replaced is restored from the newest /var/backups/antlings-* folder.
# It keeps the data folder, the settings file and the `antlings` user unless you pass --purge.
# --purge deletes /var/lib/antlings (the database and event log) and /etc/antlings. It does not delete
# the user's home folder, because that holds your projects and the Claude login.
# It never touches ufw, Postgres, Redis, other services, sudoers or the main Caddyfile.
set -euo pipefail

APP_USER=antlings
INSTALL_DIR=/opt/antlings
DATA_DIR=/var/lib/antlings
ETC_DIR=/etc/antlings
UNIT=/etc/systemd/system/antlings.service
BIN=/usr/local/bin/antlings
CADDY_FILE=/etc/caddy/antlings.caddy
CADDY_MAIN=/etc/caddy/Caddyfile
F2B_FILTER=/etc/fail2ban/filter.d/antlings.conf
F2B_JAIL=/etc/fail2ban/jail.d/antlings.local
SSHD_CONF=/etc/ssh/sshd_config.d/antlings.conf

DRY=0
PURGE=0
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
run() { if [ "$DRY" -eq 1 ]; then printf '    [dry-run] %s\n' "$*"; else printf '    + %s\n' "$*"; "$@"; fi }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done
if [ "$(id -u)" -ne 0 ] && [ "$DRY" -eq 0 ]; then die "run as root (sudo)"; fi

STATE_DIR=/var/backups/antlings-state
# The oldest backup holds the file as it was before Antlings.
backup_dir=$(find /var/backups -maxdepth 1 -type d -name 'antlings-20*' 2>/dev/null | sort | head -n 1 || true)

# Removes a file install.sh created, or puts back the one it replaced.
restore_or_remove() {
  local f=$1 saved
  saved="$backup_dir/$(echo "$f" | tr / _)"
  if [ -f "$STATE_DIR/created.list" ] && grep -qx "$f" "$STATE_DIR/created.list"; then
    if [ -e "$f" ]; then run rm -f "$f"; else note "not present: $f"; fi
  elif [ -n "$backup_dir" ] && [ -f "$saved" ]; then run cp -a "$saved" "$f"
  elif [ -e "$f" ]; then run rm -f "$f"
  else note "not present: $f"; fi
}

step "Service"
if command -v systemctl >/dev/null 2>&1; then
  run systemctl disable --now antlings || note "service was not enabled"
  restore_or_remove "$UNIT"
  run systemctl daemon-reload
else
  note "systemctl not found: skipped"
fi

step "Command"
restore_or_remove "$BIN"

step "ssh"
restore_or_remove "$SSHD_CONF"

step "fail2ban"
restore_or_remove "$F2B_FILTER"
restore_or_remove "$F2B_JAIL"
if command -v fail2ban-client >/dev/null 2>&1 && systemctl is-active --quiet fail2ban 2>/dev/null; then run fail2ban-client reload; fi

step "Caddy"
if [ -e "$CADDY_FILE" ]; then
  if grep -Eqs "^[[:space:]]*import[[:space:]]+($CADDY_FILE|/etc/caddy/\*\.caddy)" "$CADDY_MAIN"; then
    note "$CADDY_MAIN still imports the Antlings file. Remove that import line yourself, then validate and reload."
    note "The file $CADDY_FILE is kept until the import is gone."
  else
    restore_or_remove "$CADDY_FILE"
    if command -v caddy >/dev/null 2>&1 && systemctl is-active --quiet caddy 2>/dev/null; then
      if [ "$DRY" -eq 1 ]; then note "[dry-run] caddy validate --config $CADDY_MAIN, then systemctl reload caddy"
      elif caddy validate --config "$CADDY_MAIN"; then run systemctl reload caddy
      else note "WARNING: Caddy rejects the config after removal. Fix $CADDY_MAIN before the next reload."; fi
    fi
  fi
else
  note "no Antlings Caddy file"
fi

step "Program files"
run rm -rf "$INSTALL_DIR"

if [ "$PURGE" -eq 1 ]; then
  step "Purge (data and settings)"
  note "deleting the database and the settings. Back them up first if you may need them (see the runbook)."
  run rm -rf "$DATA_DIR" "$ETC_DIR"
  note "the user $APP_USER and /home/$APP_USER are kept. Remove them by hand if you want: userdel $APP_USER"
else
  step "Kept"
  note "$DATA_DIR (database, event log), $ETC_DIR (settings and secrets), user $APP_USER and its home folder."
  note "Use --purge to delete the first two."
fi
if [ "$DRY" -eq 1 ]; then note "This was a dry run. Nothing was changed."; fi
