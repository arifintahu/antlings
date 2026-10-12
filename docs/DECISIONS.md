---
title: Decisions log
tags: [antlings, decisions]
---

# Decisions #antlings

| Date | Choice | Reason |
|---|---|---|
| 2026-10-12 | Launcher values all empty: DOMAIN empty, DEPLOY=no, AUTH_MODE default, STACK default | Defaults from BUILD-PROMPT |
| 2026-10-12 | `AUTH_MODE=apikey` default, subscription behind a flag | Terms say Agent SDK products should use API keys, see [[0003-claude-login-terms]] |
| 2026-10-12 | M7 skipped | DEPLOY=no |
| 2026-10-12 | Branch `build/v0.1` created from existing `main` (3 commits already present) | Initial commit already existed |
| 2026-10-12 | `@node-rs/argon2` instead of `argon2` | Prebuilt binaries, no compiler on VPS |
| 2026-10-12 | Node 22 locally, Node 24 on the VPS; folder tests also run on Node 24 in Docker | Local machine has 22.18; code uses APIs present in both |
| 2026-10-12 | Setup: first session counts as fresh for 5 minutes | The code and a new passkey were just proven; asking again at step 3 is friction with no gain |
| 2026-10-12 | `task_updated` shows only description changes as progress; terminal states come from `task_notification` | Avoids two "done" events per subagent |
| 2026-10-12 | Subagent follow-up goes through the lead as a normal message | The SDK has no direct "resume subagent" call. The lead owns the agent id |
| 2026-10-12 | Mode list in the UI: Ask, Accept edits, Plan, Bypass (no "Auto") | `auto` is not in the allowed list of the protocol |
| 2026-10-12 | Context panel shows one bar, not the category stack | `getContextUsage({detail:'summary'})` gives totals, categories need the full call (extra token-count requests) |
| 2026-10-12 | Plan usage shown only when the SDK reports `rate_limits_available` | Live run with a subscription login returned unavailable on this machine; adapter degrades as designed |
| 2026-10-12 | Release tarball built in Docker (node:24), ships production `node_modules`, drops bundled `claude` binaries | VPS needs no compiler or pnpm. The bundled binaries are 250 MB each; the VPS uses its own `claude` |
| 2026-10-12 | `pnpm.neverBuiltDependencies: [better-sqlite3]`, installs use `--ignore-scripts` in the release build | The package ships Linux prebuilds. pnpm 9 otherwise runs `node-gyp rebuild` and fails without Python |
| 2026-10-12 | SDK, WebAuthn library loaded lazily | Idle resident memory 126 MB to 85 MB. Under the 100 MB target at cold idle |
| 2026-10-12 | Caddy rate limit is a commented block that install.sh enables only if the module exists | Stock Caddy has no rate limiter. The app lockout works without it |
| 2026-10-12 | Playwright runs on the installed Chrome (`channel: chrome`) | The machine's `PLAYWRIGHT_BROWSERS_PATH` points at another project's folder and lacks this version. Avoids a download |
| 2026-10-12 | Service and agent stay one Unix user in v0.1 | ADR 0003 and spec ask for user `antlings`. The risk is listed in ADR 0002 and the handoff |
| 2026-10-12 | Installer puts the Caddy file in `conf.d` when the main Caddyfile already imports `/etc/caddy/conf.d/*.caddy` | No edit of the main Caddyfile needed. Found on the VPS during the test deploy |
| 2026-10-12 | `--skip-dns-check` used for the test deploy | The VPS interface has a private address (NAT), the DNS check compares with interface addresses |
