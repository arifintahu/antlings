---
title: Antlings v0.1 handoff
status: ready
created: 2026-10-12
tags: [antlings, handoff]
related: [PLAN, RUNBOOK, PROGRESS, DECISIONS, BLOCKERS, 0002-authentication-and-trust-boundary]
---

# Antlings v0.1 handoff #antlings #handoff

Read this first. Nothing was pushed, merged to `main`, or deployed. Work is on branch `build/v0.1`.

## 1. Result in 10 lines

1. Built: sign-in (passkey, or password plus authenticator code), server-side sessions, step-up checks, lockout, audit log.
2. Built: Claude Code sessions through the Agent SDK. Start with folder, model, effort and mode. Stream the answer. Approve or deny tools. Interrupt. Resume. Archive. Delete.
3. Built: one worker ant per subagent with log, report and a Stop button. Context and plan-usage meters.
4. Built: Svelte web app with every mockup screen, PWA files, Web Push, offline banner, reconnect with replay by sequence number.
5. Built: deploy files for a systemd service behind Caddy, fail2ban filter and jail, installer with dry run, uninstaller, release build, runbook.
6. Tested: 3 + 174 + 81 unit tests, 20 browser tests (virtual passkey, axe, 375 px phone layout), lint, build, shellcheck. A release built in Docker passed a smoke test and a full install/uninstall test in a Node 24 Linux container.
7. Not done: M7. `DEPLOY=no`, so the VPS was never contacted. No domain was given.
8. Not verified on real systems: Caddy validation, fail2ban, Web Push on a phone, plan usage meter, a long real subagent, two sessions under memory pressure on the 2 GB VPS.
9. Idle service memory is 85 MB in a container, about 100 MB after the first passkey sign-in. The target was under 100 MB.
10. Biggest risk: the agent and the service run as the same Unix user. See section 4.

## 2. What you do next, in order

You need a machine with Docker to build, and sudo on the VPS. Details are in [[RUNBOOK]].

1. Build the release (on your machine):
   ```bash
   ./deploy/build-release.sh
   ```
   It writes `dist-release/antlings-0.1.0-<stamp>.tar.gz` and a `.sha256` file. Note the checksum.
2. Copy both files to a folder only root can write on the VPS, for example `/root/antlings-release`. Do not use `/tmp` or `/home/antlings`.
3. On the VPS, check the checksum, unpack `deploy/`, read the dry run, then install:
   ```bash
   sudo ./deploy/install.sh --dry-run --release antlings-0.1.0-<stamp>.tar.gz --domain ants.example.com
   sudo ./deploy/install.sh --release antlings-0.1.0-<stamp>.tar.gz --domain ants.example.com
   ```
   Leave out `--domain` to keep it on `127.0.0.1:3100` and reach it through an SSH tunnel.
4. Install Claude Code system-wide (for example `/usr/local/bin/claude`) so the `antlings` user can run it, and set `ANTLINGS_CLAUDE_PATH` in the env file if the installer warned. The release does not carry its own binary. Then give it a login. Use a dedicated API key with a spend cap (default mode, see [[0003-claude-login-terms]]): put `ANTHROPIC_API_KEY=...` in `/etc/antlings/antlings.env`, then `sudo systemctl restart antlings`. For a subscription login instead, read the terms ADR, set `ANTLINGS_AUTH_MODE=subscription` and `ANTLINGS_SUBSCRIPTION_OK=1`, and run `sudo -u antlings -H claude login`.
5. DNS: point an A record for your domain at the VPS. Add `import /etc/caddy/antlings.caddy` to `/etc/caddy/Caddyfile`, then `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.
6. Put your own address into `ignoreip` in `/etc/fail2ban/jail.d/antlings.local`, then `sudo fail2ban-client reload`. Run `fail2ban-regex` once against a sample line (runbook).
7. Print the one-time code: `sudo -u antlings antlings setup`. Open the site, enter it, create your passkey, optionally add the backup password and code.
8. Start a first session in a folder under `/home/antlings`. Check memory with two running sessions (`free -m`, `systemctl show antlings -p MemoryCurrent`).
9. Reload sshd so `DenyUsers antlings` applies: `sudo systemctl reload ssh`.

## 3. Test summary

| Suite | Result |
|---|---|
| `shared` | 3 passed |
| `server` | 174 passed, 1 skipped (the opt-in live SDK test) |
| `web` unit (sprite hashes, reducer) | 81 passed. The ant art is checked against the mockup's own drawing code (72 hashes, 25 frames each) |
| Browser tests (`pnpm e2e`) | 20 passed on Chrome: first run, passkey sign-in, password plus code, lockout, start, stream, approve and deny, subagent view, stop a subagent, archive, delete with step-up, Bypass step-up, reconnect after a lost connection, 375 px layout, Escape closes popovers, keyboard reach, security page, light and dark contrast, reduced motion. Axe finds no serious or critical issue. No CSP violation in any run. |
| Lint, type check, build | clean |
| shellcheck on `deploy/*.sh` | clean |
| Release smoke test (Node 24, unprivileged user) | passed: 401 without a session, encoded paths, Origin checks, WebSocket refusal, headers, idle memory 85 MB |
| Container install test | passed: dry run changes nothing, tarballs with absolute or escaping links refused (the real release's own links are accepted), real release checked by sha256, install, second install, backup of an edited unit, memory refusal, uninstall, purge |
| `pnpm audit` | no known vulnerabilities |
| Folder picker tests on Linux | 38 passed in a `node:24` container, also on Windows |

Skipped or not run, and why: the live SDK test runs only with `ANTLINGS_LIVE=1`. Two live Haiku turns were used on this machine. Caddy and fail2ban were not installed here, so their configs were not run through their own validators.

## 4. Decisions, blockers, gaps, risks

Decisions: [[DECISIONS]]. Blockers and open items: [[BLOCKERS]]. Build log: [[PROGRESS]]. Threat model: [[0002-authentication-and-trust-boundary]].

**Risks that remain on the VPS**

1. **The agent runs as the service user.** A prompt-injected agent can read `/etc/antlings/antlings.env`, the database and the Claude login, and can run `antlings reset-access`. Approvals and step-up protect against a stolen browser session, not against the agent. Use a dedicated API key with a spend cap. Keep Bypass mode rare. A second Unix user for the service is the planned fix.
2. The agent can reach everything on `127.0.0.1` (Postgres, Redis, other Node services) and any cloud metadata address. `ufw` is inactive. Add a firewall rule for the `antlings` user, see the runbook.
3. Passwordless sudo for `ubuntu`, Postgres and Redis on all interfaces, no `ufw`: outside this repository, still true.
4. Memory: 2 vCPU, 2 GB, swap already used. Two sessions are about 400 MB plus the service. The unit has `MemoryMax=1100M`. Measure before trusting it.
5. A fail2ban jail counts log lines the agent could forge. Set `ignoreip`.
6. Behind Cloudflare, configure Caddy `trusted_proxies` first.

**Known gaps**

- Step-up applies to REST and WebSocket actions that the ADR lists. Adding a passkey while a session is stale asks for a check, as designed.
- Follow-up to a subagent goes through the lead as a normal message. There is no direct resume call.
- Context panel shows one bar. The category breakdown needs the SDK's full call.
- Folder tree: the picker offers folders only under the service user's home. Dot-folders are hidden.
- Event logs and transcripts are never trimmed. Delete a session to remove both.
- No multi-user support, by design.
- The Caddy rate-limit block is commented out because it needs a plugin.
- Plan usage returned `unavailable` in the one live run (subscription login on this Windows machine).

## 5. Live SDK turns

2 of 10 used, both in the single opt-in live test (Haiku, capped at 0.10 USD per test): one tiny turn plus `getContextUsage`, then a resume after a simulated restart with a second tiny turn. The real cost was not logged by the test. Two short Haiku turns cost a few cents at most. The test removed its stub folder under `~/.claude/projects`.

## Files

| Path | What |
|---|---|
| `docs/PLAN.md` | Phases and acceptance criteria, all ticked with notes |
| `docs/RUNBOOK.md` | Operate, back up, update, roll back, rotate keys |
| `docs/screens/` | Phone screenshots from the browser tests |
| `deploy/` | Everything the installer uses |
| `docs/sdk-notes.md` | New SDK facts found during the build |
