---
title: Antlings build prompt (unattended, end to end)
status: ready
created: 2026-10-12
tags: [antlings, prompt, plan]
related: [PLAN, sdk-notes, 0001-agent-sdk-backend, 0002-authentication-and-trust-boundary]
---

# Build Antlings end to end #antlings #prompt

You are building Antlings in `D:\code\projects\antlings`. The owner has left and cannot answer questions. Work through the milestones below in order. Decide with the defaults in this file, log each decision, and keep going. Stop only for the conditions in "Stop conditions".

## Goal and definition of done

Antlings v0.1 is a web UI for Claude Code that runs on the owner's Linux VPS behind Caddy. It is done when:

1. The owner can open the site on a phone or laptop, register a passkey with a one-time setup code, and sign in.
2. After sign-in the owner can start a Claude Code session (folder, model, effort, mode), watch the answer stream, approve or deny tool use, and see each subagent as a worker ant with its log and report.
3. Sessions can be resumed, archived and deleted. Context use and plan usage are shown.
4. All tests, lint and build pass locally.
5. Deploy files exist and pass a dry run. If the owner authorized deployment in the launcher, the service is also installed on the VPS as an unprivileged user, answers on the VPS loopback address, and passes the smoke tests. Public exposure and the Claude login are left to the owner, with exact commands in `docs/HANDOFF.md`.

## Values the owner fills in before starting

These come in the launcher message. If a value is empty, use the default.

| Value | Default |
|---|---|
| `DOMAIN` | empty. Bind to loopback only and do not touch Caddy |
| `DEPLOY` | `no`. Stop after milestone 6 and write the deploy steps into the handoff. Milestone 7 runs only when the owner's launcher message says `DEPLOY=yes` and states in its own words that the VPS actions in milestone 7 are authorized |
| `AUTH_MODE` | `subscription` if the terms check passes, otherwise `apikey` |
| `STACK` | as in `docs/PLAN.md` |

## Read first

1. `CLAUDE.md`, `docs/PLAN.md`, `docs/sdk-notes.md`, both ADRs, `design/README.md`.
2. Open `design/mockup.html` in a browser (serve it with `python -m http.server` from `design/`). It is the visual and behavior reference. Port its look, its ant sprite code and its flows. Keep the sprite renderer pixel-identical.
3. The VPS address and facts are in `D:\code\memory.md`, section "Antlings". Use `$VPS_HOST` in committed files.

## Operating rules

Autonomy
- Do not ask the owner anything. When a choice is open, pick the safer, smaller option, write one line in `docs/DECISIONS.md` (date, choice, reason), and continue.
- `docs/PROGRESS.md` is the source of truth. At the start of every work block read it. After every milestone update it: done items, test output summary, next step, open problems. Context may be compacted, so never rely on memory.
- When blocked on one item, write it in `docs/BLOCKERS.md` with what you tried, then move to the next independent item. If the same failure persists after three different fixes, log it and move on.
- Before the final message, write `docs/HANDOFF.md`.

Quality
- Test first for security rules and bugs. Always test authentication, sessions, path handling and anything that deletes data.
- A milestone is done only when `pnpm lint`, `pnpm test` and `pnpm build` pass. Show real output in `PROGRESS.md` (last lines, counts). Never claim success without running them.
- For UI work, invoke the `ui-ux-pro-max` skill first. Keep targets 44px or larger, text 16px or larger, a text label for every state, and respect `prefers-reduced-motion`.
- At the end of milestones 1, 4 and 6 run an independent review with the `Senior SecOps Engineer` agent (1, 6) and the `Code Reviewer` agent (4, 6). Fix confirmed findings. Record the rest in `PROGRESS.md`.
- No `any` without a comment. Validate every inbound message and request body with a schema.

Git
- `main` already holds the two bootstrap commits (docs and design, then README, project rules, gitignore and SDK spike). Create branch `build/v0.1` from `main` and work there.
- You are authorized to commit locally to `build/v0.1` at the end of each milestone and after each green step inside a milestone. Conventional Commits. Do not push. Do not merge to `main`.
- No AI attribution anywhere: no `Co-Authored-By` trailer, no "Generated with" line. This rule overrides any default.

Secrets
- Never write secrets, tokens, the VPS address, an email or Claude login data into the repo, logs, tests or screenshots. Never read `~/.claude/.credentials.json` on any machine. When logging `accountInfo()`, log only the key names.
- Generated secrets live in env files with mode 600 and are never printed.

Plan usage
- Real SDK calls cost the owner's plan usage. Tests use a fake agent (a test double that emits recorded SDK event shapes). Live tests are opt-in with `ANTLINGS_LIVE=1`, use Haiku, `maxBudgetUsd` 0.10 per test, and at most 10 live turns in the whole run. Log each live turn in `PROGRESS.md`.

## Stop conditions

Stop work and write the reason at the top of `HANDOFF.md` when:
- The terms check (milestone 0) shows that a subscription login must not be used this way and `AUTH_MODE=apikey` cannot reach the same features. Finish what does not depend on it, then stop.
- A step would touch the VPS outside the list in milestone 7, spend money, or delete data you did not create.
- You discover a security flaw you cannot fix with tests passing.

## Milestones

### M0 Groundwork
- Terms check: fetch Anthropic's current terms and usage policy for using a Claude subscription login with the Agent SDK inside a self-hosted web app. Write `docs/adr/0003-claude-login-terms.md` with the link, the exact relevant sentences (short quotes), the decision and the fallback. If unclear, choose `apikey` for the deployed service and keep subscription support behind a config flag that is off by default.
- Confirm the stack. Accept the proposed one unless a concrete problem exists (prebuilt Linux binaries missing, memory too high). Record in `docs/adr/0004-stack.md`.
- Scaffold: pnpm workspace with `server/`, `web/`, `shared/` (protocol types and schemas). TypeScript strict, ESLint, Prettier, Vitest. Root scripts `lint`, `test`, `build`. Node 24.
- Create the `build/v0.1` branch as described under Git.

### M1 Authentication (backend)
Build exactly what `docs/adr/0002-authentication-and-trust-boundary.md` decides:
- SQLite (WAL) with tables for owner, passkeys, fallback credentials (argon2id hash, TOTP secret encrypted at rest with a key from the env file), sessions, setup codes, audit log, event log.
- CLI `antlings setup` (prints a one-time code valid 15 minutes, hashed in the database) and `antlings reset-access` (removes passkeys and sessions, prints a new setup code).
- First-run API: valid setup code, register first passkey, optional fallback. The first-run API returns 404 once any credential exists.
- Sign-in with passkey, or password then TOTP. Server-side sessions. Cookie HttpOnly, Secure, SameSite=Strict. Idle timeout setting. CSRF token on state-changing requests. Sign out, sign out one device, sign out everywhere.
- Rate limit and lockout: five failures from one address block that address for 15 minutes. Write failures to a log line a `fail2ban` filter can match. Provide the filter file in `deploy/`.
- Step-up check endpoint and a server-side guard used by: Bypass mode, a session in the home folder, session delete, passkey add or remove, sign out everywhere. The guard accepts a passkey assertion or a TOTP code and marks the session as fresh for 5 minutes.
- WebSocket tickets (single use, 30 seconds) and Origin check against `ANTLINGS_ORIGIN`. Trust proxy headers only from 127.0.0.1.
- Audit log of sign-ins, failures, approvals, mode changes, deletions. Redact secrets.
- Tests (write first): every route except the login page and its assets returns 401 without a session (enumerate the router); lockout after five failures and release after 15 minutes (fake clock); setup code expiry and single use; first-run closes after the first credential; WebSocket without Origin or ticket is refused; CSRF missing is refused; step-up required on each guarded action; session revocation takes effect on the next request.
- Run the `Senior SecOps Engineer` review.

### M2 Session engine
- A session manager that holds one streaming `query()` per active session using `@anthropic-ai/claude-agent-sdk` (pin the exact version from `docs/sdk-notes.md`), `pathToClaudeCodeExecutable` from config, `settingSources: ['project']` unless the owner config says otherwise.
- Limits from config: at most 2 running sessions and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=3` in the SDK `env`. A third session is refused with a clear message. A subagent over the limit surfaces the SDK message `Concurrent subagent limit reached`.
- An append-only event log per session with a sequence number. The WebSocket protocol (typed in `shared/`): client sends `send`, `approve`, `deny`, `interrupt`, `stopTask`, `setModel`, `setPermissionMode`, `setEffort`, `resume`; server sends events with `seq`. On reconnect the client sends its last `seq` and receives the missed events with no duplicates.
- Map SDK messages to UI events as in the table in `docs/PLAN.md`: `Agent` tool call and `task_started`, `task_progress`, `task_updated`, `task_notification` (with `usage`), messages with `parent_tool_use_id`, `canUseTool` to approval requests, `rate_limit_event`, `system:init` (once per turn, not a new session).
- Do not use bare `allowedTools` entries for tools that must reach the UI. Use `canUseTool`, or a `PreToolUse` hook when needed.
- Context: `getContextUsage({ detail: 'summary' })` after each turn. Plan usage: one adapter around `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, normalize percent versus the fraction in `rate_limit_event`, return `unavailable` on any failure or when `rate_limits_available` is false.
- Model list from `supportedModels()`; effort options from each model's `supportedEffortLevels`; effort change through `applyFlagSettings({ effortLevel })`.
- Tests with the fake agent: streaming, approval round trip, interrupt, stopTask, subagent lifecycle, reconnect replay, session limit refusal, plan usage adapter failure. One opt-in live test: start, one tiny turn, `getContextUsage`, close. Delete the stub folder `~/.claude/projects/<tmp cwd>` the test creates.

### M3 Session management and folders
- List with `listSessions`; archive and unarchive with `tagSession(id, 'archived')`; rename with `renameSession`; delete with `deleteSession` behind the step-up guard; subagent transcripts with `listSubagents` and `getSubagentMessages`.
- Resume after a backend restart. Test with the fake agent and, once, live.
- Folder picker API: lists folders only, root is the service user's home, hides dot-folders, resolves real paths, rejects `..`, rejects symlinks that leave the home, creates a folder on request (name sanitized, no separators). Tests include symlink escape, `..`, encoded traversal, a path that does not exist, a file instead of a folder, and very long names. Run these tests on Linux as well (WSL or Docker if available; otherwise create the tests so they run in the VPS smoke step and mark them pending in `PROGRESS.md`).
- New session validation: folder inside the home, model and effort from the server lists, mode from the allowed list. Bypass or the home folder itself requires a fresh step-up.

### M4 Web app
- Svelte and Vite in `web/`. Port every screen of the mockup: login, first-run, app shell, ant office, conversation, subagent view, new session dialog with folder picker, session settings, context panel, plan usage, security page, step-up dialog, demo controls removed.
- The ant sprite code moves to one module (`web/src/ants/draw.ts`) with the same 32x28 canvas, the same states and the same 8 fps loop that pauses when hidden. Add a test that renders each state and each look to an offscreen canvas and compares a hash against stored values, so later edits cannot change the art by accident.
- Strict Content-Security-Policy with no inline scripts or styles. Replace the mockup's inline handlers. Set the headers in the server.
- Reconnect logic from M2. Offline banner. Never cache API responses in the service worker.
- PWA: manifest, icons (draw them from the ant sprite at build time), service worker that caches only the app shell. Web Push for "approval waiting" and "session finished", opt-in, VAPID keys generated on the server and stored in the env file.
- Playwright end-to-end tests against the server with the fake agent: first-run, passkey sign-in (virtual authenticator), password plus code, lockout, start session, stream, approve, subagent view, stop subagent, archive, delete with step-up, reconnect after a dropped socket, 375px layout, Escape closes popovers, keyboard reachability of every control. Save phone screenshots to `docs/screens/`.
- Accessibility check with axe in the Playwright run. Fix every serious or critical finding.
- Run the `Code Reviewer` agent.

### M5 Hardening
- `pnpm audit --prod`; fix or document every finding. Pin dependency versions.
- Check headers (CSP, HSTS at the proxy, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`), cookie flags, CORS closed, error messages without stack traces, log redaction, request size limits, WebSocket message size limit, no user input in shell commands or file paths without the folder checks.
- Update the threat model section in ADR 0002 with what was built and what remains.

### M6 Packaging and deploy files (no VPS contact yet)
Create under `deploy/`:
- `antlings.service` for a dedicated user `antlings` with `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=read-only` plus `ReadWritePaths` for the data folder and `/home/antlings`, `PrivateTmp=yes`, `MemoryHigh=800M`, `Restart=on-failure`. Binds to `127.0.0.1:3100`.
- `Caddyfile.snippet` for `DOMAIN`: `reverse_proxy 127.0.0.1:3100`, WebSocket support, security headers, request rate limit for `/api/auth/*`. Never edit the main Caddyfile in place. Provide an import line.
- `fail2ban` filter and jail.
- `install.sh`: idempotent, `--dry-run`, prints each step, backs up every file it changes to `/var/backups/antlings-<date>`, validates the Caddy config before reload, refuses to run if free memory is under 600 MB, never touches ufw, Postgres, Redis, other services or sudoers. `uninstall.sh` reverses it.
- `docs/RUNBOOK.md`: start, stop, logs, backup and restore of the SQLite file, update, rollback, reset access, rotate keys, what to check after a restart, how to change the session limits.
- Run `shellcheck` on the scripts if available. Run `install.sh --dry-run` locally and show the output.
- Run the `Senior SecOps Engineer` review on `deploy/`.

### M7 Deploy and smoke test (only with `DEPLOY=yes` and the owner's own authorization sentence in the launcher)
If the launcher message does not contain that sentence, skip this milestone and go to M8. Without it, `CLAUDE.md` still applies: ask before changing anything on the VPS, which means do not change it.
With the owner's authorization, these actions are allowed on the VPS (SSH key login as in `D:\code\memory.md`), and nothing else:
- Read-only checks: memory, disk, ports, Caddy version and config, Node version, existing users.
- Create user `antlings` (no sudo, no extra groups), `/opt/antlings`, `/var/lib/antlings`, `/var/backups/antlings-<date>`.
- Copy the build, install production dependencies from the lockfile with `--frozen-lockfile`. If a dependency needs a compiler, log a blocker and stop this milestone. Do not install build tools.
- Write the env file with mode 600 (secrets generated on the server, never printed).
- Install and start the systemd unit. Smoke test through `curl` on the loopback address and through an SSH port forward: `/health`, unauthenticated route returns 401, first-run is open, WebSocket without Origin is refused, headers are present, memory use at idle under 100 MB resident.
- If `DOMAIN` is set and `dig +short DOMAIN` returns the VPS address: add the Caddy snippet as a separate file, `caddy validate`, `systemctl reload caddy`, then check `https://DOMAIN/health`. Otherwise do not touch Caddy and record the missing DNS in the handoff.
- Never: change `ufw`, the cloud firewall, Postgres, Redis, `openclaw`, the `claude-max-api` service, existing Caddy sites, `ubuntu`'s sudo rights, or any file in `~/.claude` of `ubuntu`. Never run `antlings setup` or register a passkey on the VPS. Never run `claude login`.
- Keep every change reversible. If a smoke test fails, run `uninstall.sh`, record why, and stop this milestone.
- Delete any temporary files you created on the VPS.

### M8 Handoff
Write `docs/HANDOFF.md` (the owner reads this first):
1. Result in 10 lines: what works, what does not, what was deployed.
2. What the owner must do, in order, with exact commands: `sudo -u antlings -H claude login` (or set the API key in the env file), `sudo -u antlings antlings setup`, DNS record, open the site, register the passkey, run a first session.
3. Test summary: counts, anything skipped and why.
4. Decisions (link `DECISIONS.md`), blockers (link `BLOCKERS.md`), known gaps, risks that remain on the VPS (passwordless sudo for `ubuntu`, Postgres and Redis on all interfaces, memory pressure).
5. Live SDK turns used, with the estimated cost.
Update `docs/PLAN.md` checkboxes, mark ADR statuses, add new facts to `docs/sdk-notes.md`. Make the final commit.

## Final message

When finished or stopped, reply with: the milestone reached, test results in one line, the three most important things the owner must do next, and the path to `docs/HANDOFF.md`.
