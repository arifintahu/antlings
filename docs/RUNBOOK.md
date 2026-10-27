# Antlings runbook

Everything here runs on the VPS as a sudo-capable user. Replace `$VPS_HOST` with your address. Paths are the ones `deploy/install.sh` creates.

| What | Where |
|---|---|
| Program (read-only, root-owned) | `/opt/antlings/current` (link to `/opt/antlings/releases/<id>`) |
| Previous release for rollback | `/opt/antlings/previous` |
| Database and event log | `/var/lib/antlings/antlings.db` (plus `-wal` and `-shm`) |
| Settings and secrets | `/etc/antlings/antlings.env` (mode 640, `root:antlings`). Readable by the `antlings` user, and so by the agent. See "Known limits". |
| Service | `antlings.service` |
| Command | `/usr/local/bin/antlings` (run it as the service user) |
| Sessions and projects | `/home/antlings` (the folder picker's root; Claude transcripts are in `~/.claude`) |
| Backups made by the installer | `/var/backups/antlings-<date>/` |

## One-command deploy

```bash
VPS_SSH=ubuntu@your-host DOMAIN=ants.example.com ./deploy/deploy.sh --skip-dns-check
```

It builds the release in Docker, copies it to `/root/antlings-release` on the server, runs `install.sh` there (checksum, link check, health check, rollback) and then checks `https://$DOMAIN/health`. The address stays in your shell, not in the repository. The steps below do the same by hand.

## Build and install a release

On your own machine (needs Docker, runs nothing on the VPS):

```bash
./deploy/build-release.sh            # writes dist-release/antlings-<version>-<stamp>.tar.gz
./deploy/container-test.sh dist-release/antlings-*.tar.gz   # optional: runs install and uninstall in a throwaway container
```

Copy the tarball and its `.sha256` file to a folder that only root can write on the VPS, for example `/root/antlings-release` (never `/tmp` or `/home/antlings`, where the agent could swap files before a root install). The tarball contains `deploy/` too. On the VPS:

```bash
sudo mkdir -p /root/antlings-release && cd /root/antlings-release     # put the two files here first
sha256sum -c antlings-<version>.tar.gz.sha256                          # compare with the value printed on your build machine
sudo tar -xzf antlings-<version>.tar.gz ./deploy
sudo ./deploy/install.sh --dry-run --release antlings-<version>.tar.gz --domain ants.example.com   # read the output first
sudo ./deploy/install.sh --release antlings-<version>.tar.gz --domain ants.example.com
```

Leave out `--domain` to keep the service on `127.0.0.1:3100` only. The installer checks 600 MB of free memory, refuses a tarball that contains links or unsafe paths, backs up every system file it replaces (the first copy is kept), and never touches ufw, Postgres, Redis, sudoers, other services or the main Caddyfile. If the new release does not answer `/health` it switches back to the previous one. It also adds `DenyUsers antlings` for ssh in `/etc/ssh/sshd_config.d/antlings.conf` (run `systemctl reload ssh` yourself afterwards).

After the first install you print one code over SSH, then everything else happens in the browser:

```bash
sudo -u antlings antlings setup                  # prints a one-time code, valid 15 minutes
# open the site, enter the code, create your passkey
# then connect Claude and GitHub on the Connections page
```

The command-line alternatives still work: `sudo -u antlings -H claude login`, `sudo -u antlings -H gh auth login`, or `ANTHROPIC_API_KEY` in `/etc/antlings/antlings.env`.

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
# backup into a folder only root can write (the agent can change files in /var/lib/antlings)
sudo install -d -m 700 /root/antlings-backup
sudo systemctl stop antlings
sudo cp -a --no-dereference /var/lib/antlings/antlings.db /root/antlings-backup/antlings-$(date +%F).db
sudo systemctl start antlings

# restore. Run the copy as the service user and replace the file, never follow a link:
sudo systemctl stop antlings
sudo -u antlings rm -f /var/lib/antlings/antlings.db /var/lib/antlings/antlings.db-wal /var/lib/antlings/antlings.db-shm
sudo install -m 600 -o antlings -g antlings /root/antlings-backup/antlings-<date>.db /var/lib/antlings/antlings.db
sudo systemctl start antlings
```

Stopping the service first gives a consistent copy without extra tools.

## Update and roll back

```bash
sudo ./deploy/install.sh --release antlings-<new>.tar.gz     # unpacks next to the old one, switches the link, restarts
# roll back (only if /opt/antlings/previous exists)
test -L /opt/antlings/previous && sudo ln -sfn "$(readlink /opt/antlings/previous)" /opt/antlings/current.new && sudo mv -T /opt/antlings/current.new /opt/antlings/current
sudo systemctl restart antlings
```

Back up the database before an update. v0.1 only adds tables, but a later release may change columns, and then an older release cannot read the new database.

Test a new Agent SDK version with `ANTLINGS_LIVE=1 pnpm --filter @antlings/server test` before building a release. The SDK version is pinned.

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
| `ANTLINGS_SECRET_KEY` (encrypts the authenticator secret) | 1. Run `sudo -u antlings antlings reset-access` (removes the stored authenticator). 2. Edit the env file and restart. 3. Register again with the new setup code and set up the fallback again. The old secret cannot decrypt anything afterwards. Generate a value with `sudo -u antlings antlings gen-env | grep ^ANTLINGS_SECRET_KEY=` (this prints one secret line; do it on a private terminal). |
| VAPID keys (push) | Replace both `ANTLINGS_VAPID_*` lines with the output of `antlings gen-env`, restart, then turn push notifications off and on again on each device |
| Anthropic API key | Connections page: save the new key (a saved key wins over the env file), or edit `ANTHROPIC_API_KEY` in the env file and `sudo systemctl restart antlings`. After rotating `ANTLINGS_SECRET_KEY` a key saved on the Connections page can no longer be decrypted, so save it again. |
| GitHub login | Connections page: Disconnect, then Connect again |

Never paste these values into chat, issues or the repository.

## Change limits and settings

Edit `/etc/antlings/antlings.env`, then `sudo systemctl restart antlings`. Running sessions end and resume on the next message.

| Setting | Meaning | Default |
|---|---|---|
| `ANTLINGS_MAX_SESSIONS` | Claude Code processes running at once. Each uses about 200 MB. | 2 |
| `ANTLINGS_MAX_SUBAGENTS` | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` for each session | 3 |
| `ANTLINGS_IDLE_HOURS` | Sign-in idle timeout (also on the Security page) | 12 |
| `ANTLINGS_AUTH_MODE` | `apikey`, or `subscription` with `ANTLINGS_SUBSCRIPTION_OK=1`. Read [0003-claude-login-terms](adr/0003-claude-login-terms.md) first. | `apikey` |
| `ANTLINGS_HOME` | Root of the folder picker | `/home/antlings` |
| `ANTLINGS_EVENT_KEEP` | Newest events kept per session in the log. Older ones stay in the Claude transcript. | 20000 |

The memory limit is `MemoryHigh=800M` in `/etc/systemd/system/antlings.service`. Change it with `sudo systemctl edit antlings`, not by editing the installed file.

## fail2ban

Set `ignoreip` in `/etc/fail2ban/jail.d/antlings.local` to your own address first.

```bash
sudo fail2ban-client status antlings
sudo fail2ban-client set antlings unbanip 203.0.113.9
```

The app already blocks an address for 15 minutes after 5 failures (`journalctl -u antlings | grep antlings-auth-lockout`). The jail adds a firewall ban after 10 failures in an hour. If you put Cloudflare in front, configure Caddy `trusted_proxies` first, otherwise every visitor shares one address.

## Uninstall

```bash
sudo ./deploy/uninstall.sh --dry-run
sudo ./deploy/uninstall.sh            # keeps the database, settings and the antlings user
sudo ./deploy/uninstall.sh --purge    # also deletes /var/lib/antlings and /etc/antlings. Back them up first
```

If the main Caddyfile still imports `antlings.caddy`, remove that line yourself first.

## Known limits

- **The agent can read what the service can read.** That includes the GitHub login (`~/.config/gh/hosts.yml`) and an API key saved on the Connections page: the key is encrypted with `ANTLINGS_SECRET_KEY`, which the agent can also read from the env file, so the encryption protects the database at rest, not the key from the agent. Connect a GitHub account, or limit its access, that you are happy to share with the agent. The service and the agent run as the same Unix user, so a prompt-injected agent can read `/etc/antlings/antlings.env` (secret key, VAPID key, API key), the database, and `~/.claude/.credentials.json`, and can run `antlings reset-access`. Approvals and step-up protect against a stolen browser session, not against the agent. Use a dedicated API key with a spend cap, keep Bypass mode rare, and read the first item in the threat model of [0002-authentication-and-trust-boundary](adr/0002-authentication-and-trust-boundary.md).
- **Session terminals are a shell as `antlings`.** Opening one needs no passkey or code, only a signed-in session. Shells live in the service process: a restart, deploy or crash ends them, as do archiving or deleting the session and closing the tab. At most 4 run per session and 12 in total, and the agent's 15 minute idle rule does not touch them. They share the unit's `MemoryMax` and `TasksMax` and its sandbox (`ProtectHome=read-only`, writes only under `/var/lib/antlings` and `/home/antlings`). To list or end leftover shells by hand: `pgrep -u antlings -a -f 'bash -l'` and `sudo pkill -u antlings -f 'bash -l'`. Opening and closing a shell is in the audit log; what is typed or printed is never logged.
- The agent can reach every service on `127.0.0.1` (Postgres, Redis, the other Node services) and the cloud metadata address. `ufw` does not cover that. A firewall rule that rejects traffic from the `antlings` user to those ports is the fix, for example with nftables `meta skuid antlings`. It is not part of the installer because it must match your other services.
- fail2ban counts log lines, and the agent can write log lines. The jail has an `ignoreip` list for that reason. Put your own address in it.
- Event logs grow with use. Delete a session in the app to remove its log and transcript.
- Plan usage needs a subscription login. With an API key the meter shows "unavailable".
