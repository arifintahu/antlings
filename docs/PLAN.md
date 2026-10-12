---
title: Antlings plan
status: v0.1 built
created: 2026-10-12
updated: 2026-10-12
tags: [antlings, plan]
related: [sdk-notes, 0001-agent-sdk-backend, 0002-authentication-and-trust-boundary]
---

# Antlings plan #antlings #plan

Antlings is a self-hosted web UI for Claude Code on a Linux VPS. Each session has a lead ant. Each subagent is a worker ant at its own desk.

## User and job

- User: one developer who codes daily with Claude Code on a small VPS, from a laptop and a phone.
- Job: start, watch, approve and resume Claude Code sessions from a browser, with the session switching and approval flow of Claude Desktop's Code tab.
- Starting point: CloudDesktop (VNC desktop in a browser) worked, but it spends memory on a desktop and a browser that the job does not need. It is also no longer maintained.

## Goals

1. Sessions: list, open, resume, archive, delete. New session with folder, model, effort and mode.
2. Conversation: streamed output, tool calls, approve or deny from the page.
3. Subagents: one ant per subagent with state, current tool, tokens, log, final report, follow-up and stop.
4. Meters: context window per session, plan usage (5-hour and weekly).
5. Phone: installable web app, usable one-handed, notifications when an approval is waiting.
6. Access control: login with passkey, or password plus one-time code. See [[0002-authentication-and-trust-boundary]].

## Non-goals for the first release

- More than one user, sign-up, billing.
- File editor, terminal, git interface, desktop streaming.
- Running agents on other machines.
- Providers other than Claude Code.

## Success metrics

| Metric | Target |
|---|---|
| Backend idle memory | under 100 MB resident |
| Two running sessions on the 2 GB VPS | swap use does not grow during a 30-minute run |
| Tap on Approve to tool running | under 1 second on a warm session |
| Unauthenticated routes | none besides the login page and its assets (checked by an automated route test) |
| Reconnect after phone sleep | the page shows the missed events within 2 seconds, with no duplicates |

## Architecture

```
Phone / laptop (PWA)
      | HTTPS
    Caddy (already on the VPS: TLS, rate limit)
      | 127.0.0.1
 Antlings backend (Node, runs as the unprivileged user "antlings")
      |  one streaming query() per active session
 Claude Agent SDK -> /usr/bin/claude (Claude Code)
      |
 ~/.claude/projects/... (session transcripts)       SQLite (auth, event log, archive flags)
```

- One long-lived streaming `query()` per active session. Idle sessions are closed and restored later with `resume`.
- The backend writes every event to an append-only log in SQLite with a sequence number. The page reconnects with its last sequence number and replays what it missed.
- Archive is a tag set with `tagSession`. Delete calls `deleteSession`. See [[sdk-notes]].

### Event to UI mapping

| UI element | Source |
|---|---|
| Ant appears | `Agent` tool call, then `task_started` (`task_type: local_agent`) |
| Ant state and current tool | `task_progress`, `assistant` messages with `parent_tool_use_id` |
| Ant finished | `task_notification` (`completed`, `failed`, `stopped`) with `usage` |
| Approve / Deny | `canUseTool` callback |
| Stop one ant | `query.stopTask(taskId)` |
| Stop the turn | `query.interrupt()` |
| Context meter | `query.getContextUsage({ detail: 'summary' })` |
| Plan usage | `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` and `rate_limit_event` |
| Model, mode, effort | `setModel`, `setPermissionMode`, `applyFlagSettings({ effortLevel })` |

## VPS limits (measured 2026-10-12)

- 2 vCPU, 1,967 MB RAM, about 950 MB available, 1 GB of 2 GB swap already in use.
- Other services run on the same machine: Postgres, Redis, Caddy and two Node services.
- One Claude Code session added about 200 MB in a single run. A subagent added about 33 MB.
- Plan: at most 2 running sessions, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=3`, and a refusal message in the UI when the limit is reached.

## Proposed stack (confirm before Phase 1)

- Backend: Node 24, TypeScript, pnpm, Fastify, `ws`, `better-sqlite3`, `@simplewebauthn/server`, `otpauth`.
- Frontend: Svelte and Vite, canvas sprites, no UI framework.
- Run: systemd service bound to 127.0.0.1, Caddy in front.
- Reason for Node: the Agent SDK is a TypeScript package, so the backend calls it directly.

## Phases and acceptance criteria

### Phase 0: groundwork (done)

- [x] Mockup with ant characters.
- [x] SDK spike on the VPS, recorded in [[sdk-notes]].
- [x] Decisions [[0001-agent-sdk-backend]] and [[0002-authentication-and-trust-boundary]] reviewed (accepted at v0.1, see their threat-model notes).
- [x] Stack confirmed in [[0004-stack]].

### Phase 1: sign in and one conversation

- [x] Owner can register a passkey from the server console and sign in with it (setup code from `antlings setup`; end-to-end test with a virtual passkey).
- [x] Password plus one-time code works as a fallback (unit and end-to-end tests).
- [x] Every route except the login page and its assets returns 401 without a valid session (route test enumerates the router, also encoded paths).
- [x] A WebSocket upgrade without a valid Origin and ticket is refused (`ws.test.ts`, release smoke test).
- [x] Five failed sign-ins from one address block further attempts for 15 minutes (fake-clock test, 30-request burst test, end-to-end test).
- [x] One session streams text and tool calls, and Approve and Deny reach `canUseTool` (fake agent, end-to-end, one live turn).
- [x] The backend runs as the `antlings` user with no sudo (installer refuses privileged groups; container install test). Not yet run on the VPS.

### Phase 2: session management

- [x] New session dialog: folder (browse and create), model, effort, mode.
- [x] The folder picker lists only folders inside the user's home, hides dot-folders, and rejects `..` and symlinks that leave the home (38 tests, Windows and Linux).
- [x] Session list shows Active and Archived. Archive and unarchive use tags. Delete removes the transcript and asks for confirmation plus a step-up.
- [x] Resume a session after a backend restart and see the earlier messages (fake agent test, one live test, event log replay).
- [x] Bypass mode and deleting a session ask for the passkey or code again (REST, WebSocket and end-to-end tests).

### Phase 3: ants, meters, limits

- [x] One ant per subagent with state, tokens and elapsed time.
- [x] Subagent view shows log, report and prompt. Follow-up goes through the lead, which resumes the agent ([[DECISIONS]]).
- [x] Stop works for one ant (`stopTask`, end-to-end test). Not yet seen against a real long subagent.
- [x] Context meter updates after each turn. Plan usage updates after each turn and on `rate_limit_event`, and shows "unavailable" when the SDK says so.
- [x] A third concurrent session is refused with a clear message.

### Phase 4: phone

- [x] Installable web app with an icon (drawn from the ant sprite) and a standalone manifest. Not yet installed on a real phone.
- [x] Web Push when an approval is waiting or a session finishes, and on sign-in (server and service worker tested with a fake push service). Not yet tested on a real device or on iOS.
- [x] Reconnect test: the page loses its connection, the server logs two events, the page reconnects and shows each once. A real 5-minute phone sleep is not tested.

## Risks and open questions

| Item | Status |
|---|---|
| Terms for using a Claude subscription login behind a self-hosted web app | Checked 2026-10-12, see [[0003-claude-login-terms]]. Default is an API key. Subscription mode sits behind a flag that is off. |
| Plan usage API is marked experimental and may change | Wrap it in one adapter, pin the SDK version, show "unavailable" when it fails. |
| `task_progress` events | Mapped and tested with recorded shapes. Not yet seen from a real long subagent. |
| Effect of `applyFlagSettings({ effortLevel })` | Wired to the settings dialog. The UI says it applies from the next turn. Effect not observed. |
| Passwordless sudo for `ubuntu` on the VPS | Observed. The agent must run as another user. That user needs its own Claude login. |
| Postgres and Redis listen on all interfaces, `ufw` inactive | Check the cloud firewall. Not part of Antlings, but it raises the damage of a break-in. |
| Memory pressure on the VPS | Service idle is about 85 MB (measured in a container). Measure two real sessions on the VPS after deploy. |
| Domain and trademark check for the name | Not done. npm and GitHub name search found no clash for "antlings". |
