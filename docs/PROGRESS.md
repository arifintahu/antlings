---
title: Build progress
tags: [antlings, progress]
---

# Progress #antlings

Launcher: DOMAIN empty, DEPLOY=no, AUTH_MODE default (apikey), STACK default. Live SDK turns used: 2 of 10 (M3 live test, Haiku, about 2 short turns).
Branch `build/v0.1`, nothing pushed, nothing merged to `main`.

## Done
- M0 groundwork: ADR 0003 (terms, API key by default), ADR 0004 (stack), pnpm workspace.
- M1 authentication: passkey, password plus TOTP, server sessions, CSRF and Origin, lockout (per address, IPv6 /64, global), step-up, ws tickets, audit, CLI. SecOps review done, 17 of 20 findings fixed, the rest are deploy-time and listed in the handoff.
- M2 session engine: fake agent tests for streaming, approvals, interrupt, stopTask, subagents, replay (paged), limits, plan usage failure. One live test passed (start, turn, context, close, resume with a second manager).
- M3 session management: list, archive, rename, delete (step-up), folder picker (Windows and Linux/Node 24), new-session validation, history import, subagent transcripts.
- M4 web app: Svelte app with every mockup screen, sprite module with hash tests against the mockup's own code, PWA, push, 20 Playwright tests with a virtual passkey and axe (light and dark), phone screenshots in `docs/screens/`. Code Reviewer findings fixed (replay paging, socket race, lost sends, push, a11y).
- M5 hardening: `pnpm audit` clean, versions pinned, header/CORS/size/log tests, ADR 0002 threat model section.
- M6 deploy files: unit, Caddy snippet, fail2ban, installer, uninstaller, release build in Docker, smoke test, container install test, runbook. SecOps and Code Reviewer findings on `deploy/` and the server changes applied (link check that failed open, release links, rollback, concurrent starts, ws idle and ping, push allowlist).

## Test output (last run)
- shared 3, server 174 (1 live test skipped), web 81, e2e 20. `pnpm lint`, `pnpm test`, `pnpm build` clean. shellcheck clean on all scripts.
- Release smoke test in a Node 24 container as an unprivileged user: all checks pass, idle memory 85 MB.
- Container install test (real install, second install, backup of an edited unit, low-memory refusal, uninstall, purge): all pass.

## Next
- M7 skipped (DEPLOY=no). M8 handoff.

## Open problems
- Plan usage returned `unavailable` in the live run (subscription login on this machine).
- Idle memory after the first passkey sign-in is about 100 MB (WebAuthn library loads), target says under 100 MB at idle.
- Service and agent share one Unix user (listed in ADR 0002 and the handoff).
