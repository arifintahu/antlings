---
title: Antlings runbook
status: v0.1
created: 2026-10-12
tags: [antlings, runbook, ops]
related: [PLAN, HANDOFF, 0002-authentication-and-trust-boundary]
---

# Antlings runbook #antlings #ops

Everything here runs on the VPS as a sudo-capable user. Replace `$VPS_HOST` with your address. Paths are the ones `deploy/install.sh` creates.

| What | Where |
|---|---|
| Program (read-only, root-owned) | `/opt/antlings/current` (link to `/opt/antlings/releases/<id>`) |
| Previous release for rollback | `/opt/antlings/previous` |
| Database and event log | `/var/lib/antlings/antlings.db` (plus `-wal` and `-shm`) |
| Settings and secrets | `/etc/antlings/antlings.env` (mode 640, `root:antlings`) |
| Service | `antlings.service` |
| Command | `/usr/local/bin/antlings` (run it as the service user) |
| Sessions and projects | `/home/antlings` (the folder picker's root; Claude transcripts are in `~/.claude`) |
| Backups made by the installer | `/var/backups/antlings-<date>/` |

## Build and install a release

On your own machine (needs Docker, runs nothing on the VPS):

```bash
./deploy/build-release.sh            # writes dist-release/antlings-<version>-<stamp>.tar.gz
./deploy/container-test.sh dist-release/antlings-*.tar.gz   # optional: runs install and uninstall in a throwaway container
```

Copy the tarball and the `deploy` folder to the VPS (the tarball contains `deploy/` too). On the VPS:

```bash
tar -xzf antlings-<version>.tar.gz deploy
sudo ./deploy/install.sh --dry-run --release antlings-<version>.tar.gz --domain ants.example.com   # read the output first
sudo ./deploy/install.sh --release antlings-<version>.tar.gz --domain ants.example.com
```

Leave out `--domain` to keep the service on `127.0.0.1:3100` only. The installer checks 600 MB of free memory, makes a backup of every file it replaces, and never touches ufw, Postgres, Redis, sudoers, other services or the main Caddyfile.

After the first install you do three things yourself:

```bash
sudo -u antlings -H claude login                 # or set ANTHROPIC_API_KEY in /etc/antlings/antlings.env
sudo -u antlings antlings setup                  # prints a one-time code, valid 15 minutes
# open the site, enter the code, create your passkey
```

With a domain, add this line to `/etc/caddy/Caddyfile` once, then `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`:

```
import /etc/caddy/antlings.caddy
```

Without a domain, use an SSH tunnel and open `http://localhost:3100` (passkeys work on `localhost`):

```bash
ssh -L 3100:127.0.0.1:3100 $VPS_USER@$VPS_HOST
```

## Start, stop, logs, status

```bash
sudo systemctl status antlings
sudo systemctl restart antlings
sudo systemctl stop antlings
sudo journalctl -u antlings -n 100 --no-pager
sudo journalctl -u antlings -f
curl -s http://127.0.0.1:3100/health          # {"ok":true}
```

## What to check after a restart

1. `curl -s http://127.0.0.1:3100/health` answers.
2. `systemctl show antlings -p MemoryCurrent` is well under 100 MB at idle (about 85 MB measured, 100 to 110 MB after the first passkey sign-in).
3. Open the site. Sign-in should work without a new setup code. Sessions that were running show as closed and resume on your next message. An approval that was waiting is closed as denied.
4. `free -m`: the other services on this machine are still fine, swap is not growing.

## Back up and restore the database

The database holds your passkeys, sessions, audit log and the event log of every conversation. Transcripts live separately in `/home/antlings/.claude/projects`.

```bash
# backup (safe while running: SQLite online backup)
sudo -u antlings sqlite3 /var/lib/antlings/antlings.db ".backup '/var/lib/antlings/backup-$(date +%F).db'"
# or stop the service and copy the three files
sudo systemctl stop antlings
sudo cp -a /var/lib/antlings/antlings.db* /root/antlings-backup/
sudo systemctl start antlings

# restore
sudo systemctl stop antlings
sudo cp /root/antlings-backup/antlings.db /var/lib/antlings/antlings.db
sudo rm -f /var/lib/antlings/antlings.db-wal /var/lib/antlings/antlings.db-shm
sudo chown antlings:antlings /var/lib/antlings/antlings.db && sudo chmod 600 /var/lib/antlings/antlings.db
sudo systemctl start antlings
```

If `sqlite3` is not installed, use the stop-and-copy method.

## Update and roll back

```bash
sudo ./deploy/install.sh --release antlings-<new>.tar.gz     # unpacks next to the old one, switches the link, restarts
# roll back
sudo ln -sfn "$(readlink /opt/antlings/previous)" /opt/antlings/current.new && sudo mv -T /opt/antlings/current.new /opt/antlings/current
sudo systemctl restart antlings
```

The database schema only gets new tables with `CREATE TABLE IF NOT EXISTS`, so an older release can read a newer database. Back up before an update anyway.

Test a new Agent SDK version with `spikes/sdk-spike.mjs` and `ANTLINGS_LIVE=1 pnpm --filter @antlings/server test` before building a release. The SDK version is pinned.

## Reset access (lost passkey)

```bash
sudo -u antlings antlings reset-access
```

This removes every passkey, the password fallback and every sign-in, then prints a new setup code. Open the site and register again. Sessions and transcripts are not touched.

## Rotate keys

| Key | How |
|---|---|
| Passkeys | Security page: add the new one, then remove the old one (both ask for a fresh check) |
| Password and authenticator | Security page: replace password and code |
| `ANTLINGS_SECRET_KEY` (encrypts the authenticator secret) | `reset-access`, then set up the fallback again. Edit the env file only after that, because the old secret can no longer be decrypted. Generate a value with `sudo -u antlings antlings gen-env` and copy only the `ANTLINGS_SECRET_KEY` line. |
| VAPID keys (push) | Replace both `ANTLINGS_VAPID_*` lines with the output of `antlings gen-env`, restart, then turn push notifications off and on again on each device |
| Anthropic API key | Edit `ANTHROPIC_API_KEY` in the env file, `sudo systemctl restart antlings` |

Never paste these values into chat, issues or the repository.

## Change limits and settings

Edit `/etc/antlings/antlings.env`, then `sudo systemctl restart antlings`. Running sessions end and resume on the next message.

| Setting | Meaning | Default |
|---|---|---|
| `ANTLINGS_MAX_SESSIONS` | Claude Code processes running at once. Each uses about 200 MB. | 2 |
| `ANTLINGS_MAX_SUBAGENTS` | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` for each session | 3 |
| `ANTLINGS_IDLE_HOURS` | Sign-in idle timeout (also on the Security page) | 12 |
| `ANTLINGS_AUTH_MODE` | `apikey`, or `subscription` with `ANTLINGS_SUBSCRIPTION_OK=1`. Read [[0003-claude-login-terms]] first. | `apikey` |
| `ANTLINGS_HOME` | Root of the folder picker | `/home/antlings` |

The memory limit is `MemoryHigh=800M` in `/etc/systemd/system/antlings.service`. Change it with `sudo systemctl edit antlings`, not by editing the installed file.

## fail2ban

```bash
sudo fail2ban-client status antlings
sudo fail2ban-client set antlings unbanip 203.0.113.9
```

The app already blocks an address for 15 minutes after 5 failures (`journalctl -u antlings | grep antlings-auth-lockout`). The jail adds a firewall ban after 10 failures in an hour. If you put Cloudflare in front, configure Caddy `trusted_proxies` first, otherwise every visitor shares one address.

## Uninstall

```bash
sudo ./deploy/uninstall.sh --dry-run
sudo ./deploy/uninstall.sh            # keeps the database, settings and the antlings user
sudo ./deploy/uninstall.sh --purge    # also deletes /var/lib/antlings and /etc/antlings
```

If the main Caddyfile still imports `antlings.caddy`, remove that line yourself first.

## Known limits

- The service and the agent run as the same Unix user. Read the first item in the threat model of [[0002-authentication-and-trust-boundary]] before using Bypass mode.
- Event logs grow with use. Delete a session in the app to remove its log and transcript.
- Plan usage needs a subscription login. With an API key the meter shows "unavailable".
