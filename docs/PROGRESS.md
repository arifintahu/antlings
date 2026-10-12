---
title: Build progress
tags: [antlings, progress]
---

# Progress #antlings

Launcher: DOMAIN empty, DEPLOY=no, AUTH_MODE default (apikey), STACK default. Live SDK turns used: 2 of 10 (M3 live test, Haiku).

## Done
- M0 groundwork: ADR 0003 (terms), ADR 0004 (stack), pnpm workspace, branch `build/v0.1`.
- M1 authentication: passkey and password+TOTP, server sessions, CSRF and Origin checks, lockout, step-up, ws tickets, audit, CLI `setup` / `reset-access`. SecOps review done; 17 of 20 findings fixed (see below).
- M2 session engine: fake-agent tests for streaming, approvals, interrupt, stopTask, subagent lifecycle, reconnect replay, limit refusal, plan usage failure. Live test passed once (start, turn, context, close, resume with a second manager).
- M3 session management: REST for list/archive/rename/delete, folder picker, new-session validation, history import, subagent transcripts. Folder tests pass on Windows and in Linux (node:24 container).

## Test output (last run)
- shared 3 passed. server 129 passed, 1 skipped (live, opt-in). lint clean, build clean.

## SecOps review findings (M1)
Fixed: encoded-path auth bypass (default deny), parallel lockout bypass (attempts counted before checking), IPv6 /64 keying plus a global brake (100 failures), confirm and settings routes now need step-up and lockout, 30-day absolute session lifetime, cookie clear flags, fallback change audited and old fallback kept until confirmation, challenge cap, audit pruning, log line sanitising, 3 TOTP tries per password step, file mode 600, CSRF constant-time compare, loopback-only bind and https origin in production, UV required on passkeys, SDK child env allowlist.
Open (deploy-time, in HANDOFF): service and agent share one Unix user, so the agent can read the database and env file. Caddy `trusted_proxies` needed if Cloudflare is added. HSTS is set at Caddy.

## Next
- M4 web app (Svelte), then M5, M6, M8. M7 skipped (DEPLOY=no).

## Open problems
- Local Node is 22.18, VPS Node 24 (tests run on 22 locally, folder tests also on 24 in Docker).
- Plan usage returned `unavailable` in the live run on this machine (subscription login, SDK 0.3.296). Adapter works as designed; record in sdk-notes.
