#!/usr/bin/env bash
# Runs install.sh and uninstall.sh for real inside a throwaway Linux container, with a fake `systemctl`.
# It checks files, modes, ownership, idempotency and that the installed service answers /health.
# Local use only. Never run this on the VPS.
#
#   deploy/container-test.sh dist-release/antlings-0.1.0-<stamp>.tar.gz
set -euo pipefail

TAR=$(cd "$(dirname "${1:?usage: container-test.sh <release.tar.gz>}")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Git Bash on Windows needs native paths for docker mounts.
if command -v cygpath >/dev/null 2>&1; then TAR=$(cygpath -m "$TAR"); HERE=$(cygpath -m "$HERE"); fi

MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$TAR:/rel/release.tar.gz:ro" -v "$HERE:/dep:ro" \
  node:24-slim bash -c '
set -euo pipefail
apt-get update >/dev/null 2>&1
apt-get install -y curl procps >/dev/null 2>&1

# A fake systemctl: records calls, and starts or stops the service as the antlings user.
cat > /usr/bin/systemctl <<"SH"
#!/bin/bash
echo "systemctl $*" >> /tmp/systemctl.log
case "$1" in
  restart|start)
    pkill -u antlings -f "dist/main.js" 2>/dev/null || true
    su antlings -s /bin/bash -c "set -a; . /etc/antlings/antlings.env; set +a; cd /opt/antlings/current/app && NODE_ENV=production nohup node dist/main.js >/tmp/antlings.out 2>&1 &"
    ;;
  disable) pkill -u antlings -f "dist/main.js" 2>/dev/null || true ;;
  show) echo "MemoryCurrent=0" ;;
  is-active) exit 3 ;;
esac
exit 0
SH
chmod +x /usr/bin/systemctl

ok() { printf "ok   %s\n" "$*"; }
bad() { printf "FAIL %s\n" "$*" >&2; exit 1; }
expect_eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1: expected $2, got $3"; }

echo "--- first install"
bash /dep/install.sh --release /rel/release.tar.gz > /tmp/install1.log 2>&1 || { cat /tmp/install1.log; bad "install failed"; }
expect_eq "env file mode and owner" "640 root antlings" "$(stat -c "%a %U %G" /etc/antlings/antlings.env)"
expect_eq "data dir mode and owner" "700 antlings antlings" "$(stat -c "%a %U %G" /var/lib/antlings)"
expect_eq "app code is owned by root" "root" "$(stat -c %U /opt/antlings/current/app/dist/main.js)"
expect_eq "unit installed" "644" "$(stat -c %a /etc/systemd/system/antlings.service)"
expect_eq "command installed" "755" "$(stat -c %a /usr/local/bin/antlings)"
id -nG antlings | tr " " "\n" | grep -qxE "sudo|wheel|admin|root" && bad "antlings is in a privileged group" || ok "antlings has no privileged group"
grep -q "ANTLINGS_SECRET_KEY=" /etc/antlings/antlings.env && ok "secrets generated" || bad "no secret key"
grep -q "ANTLINGS_ORIGIN=http://localhost:3100" /etc/antlings/antlings.env && ok "origin defaults to localhost without a domain" || bad "origin"
if grep -qE "SECRET_KEY=|VAPID_PRIVATE=" /tmp/install1.log; then bad "installer printed a secret"; else ok "installer printed no secret"; fi
curl -fsS http://127.0.0.1:3100/health | grep -q "\"ok\":true" && ok "service answers /health as user antlings" || bad "health"
expect_eq "service runs as antlings" "antlings" "$(ps -o user= -p "$(pgrep -f "^node dist/main.js$" | head -1)" | tr -d " ")"

echo "--- setup as the service user"
code=$(su antlings -s /bin/bash -c "antlings setup" | head -1)
case "$code" in "Setup code: ANT-"*) ok "antlings setup prints a code" ;; *) bad "setup output: $code" ;; esac
su antlings -s /bin/bash -c "antlings setup" >/dev/null 2>&1 && ok "a second setup prints a fresh code while nothing is set up" || bad "second setup"
curl -fsS http://127.0.0.1:3100/api/auth/status | grep -q "\"firstRun\":true" && ok "first run is open on the running service" || bad "status"

echo "--- second install is a no-op for settings"
cp /etc/antlings/antlings.env /tmp/env.before
bash /dep/install.sh --release /rel/release.tar.gz > /tmp/install2.log 2>&1 || { cat /tmp/install2.log; bad "second install failed"; }
cmp -s /tmp/env.before /etc/antlings/antlings.env && ok "env file untouched by a second install" || bad "env changed"
grep -q "unchanged: /etc/systemd/system/antlings.service" /tmp/install2.log && ok "unit reported unchanged" || bad "unit not unchanged"

echo "--- changed unit is backed up"
echo "# local edit" >> /etc/systemd/system/antlings.service
bash /dep/install.sh --release /rel/release.tar.gz > /tmp/install3.log 2>&1 || bad "third install failed"
ls /var/backups/antlings-*/ | grep -q "_etc_systemd_system_antlings.service" && ok "edited unit was backed up before replacement" || bad "no backup"
grep -q "local edit" /etc/systemd/system/antlings.service && bad "unit not replaced" || ok "unit replaced"

echo "--- low memory refusal"
sed "s/^MIN_FREE_MB=600/MIN_FREE_MB=999999/" /dep/install.sh > /tmp/install-lowmem.sh
cp /dep/antlings.service /tmp/ && cp -r /dep/fail2ban /tmp/ && cp /dep/Caddyfile.snippet /tmp/
if bash /tmp/install-lowmem.sh --release /rel/release.tar.gz > /tmp/lowmem.log 2>&1; then bad "did not refuse"; else grep -q "free" /tmp/lowmem.log && ok "refuses when memory is low" || bad "wrong error"; fi

echo "--- uninstall"
bash /dep/uninstall.sh > /tmp/uninstall.log 2>&1 || { cat /tmp/uninstall.log; bad "uninstall failed"; }
[ ! -e /opt/antlings ] && ok "program files removed" || bad "/opt/antlings remains"
[ ! -e /usr/local/bin/antlings ] && ok "command removed" || bad "command remains"
[ -f /etc/antlings/antlings.env ] && [ -d /var/lib/antlings ] && ok "settings and data kept without --purge" || bad "data removed without purge"
id antlings >/dev/null 2>&1 && ok "user kept" || bad "user removed"
bash /dep/uninstall.sh --purge > /tmp/purge.log 2>&1 || bad "purge failed"
[ ! -e /var/lib/antlings ] && [ ! -e /etc/antlings ] && ok "purge removes data and settings" || bad "purge incomplete"
echo
echo "container test passed"
'
