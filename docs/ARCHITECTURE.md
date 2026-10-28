# Architecture

Antlings is a self-hosted web UI for Claude Code. Each session has a lead ant. Each subagent is a worker ant at its own desk.

Scope: one owner, one server, Claude Code only. There is no sign-up, billing, file editor, terminal or multi-user support, and agents do not run on other machines.

## How it fits together

```
Phone / laptop (PWA)
      | HTTPS
    Caddy (TLS)
      | 127.0.0.1
 Antlings backend (Node, runs as the unprivileged user "antlings")
      |  one streaming query() per active session
 Claude Agent SDK -> /usr/bin/claude (Claude Code)
      |
 ~/.claude/projects/... (session transcripts)       SQLite (auth, event log, archive flags)
```

- One long-lived streaming `query()` per active session. Idle sessions are closed and restored later with `resume`.
- The backend writes every event to an append-only log in SQLite with a sequence number. The page reconnects with its last sequence number and replays what it missed.
- Archive is a tag set with `tagSession`. Delete calls `deleteSession`. See [SDK notes](sdk-notes.md).

### Event to UI mapping

| UI element | Source |
|---|---|
| Ant appears | `Agent` tool call, then `task_started` (`task_type: local_agent`) |
| Ant state and current tool | `task_progress`, `assistant` messages with `parent_tool_use_id` |
| Ant finished | `task_notification` (`completed`, `failed`, `stopped`) with `usage` |
| Approve / Deny | `canUseTool` callback |
| Stop one ant | `query.stopTask(taskId)` |
| Stop the turn | `query.interrupt()` |
| Attachment | `POST /api/sessions/:id/uploads`, then `send` with `attachmentIds`; images become image blocks, other files a path list |
| Context meter | `query.getContextUsage({ detail: 'summary' })` |
| Plan usage | `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` and `rate_limit_event` |
| Model, mode, effort | `setModel`, `setPermissionMode`, `applyFlagSettings({ effortLevel })` |

## Design choices

- **Sessions stay in Claude Code's own transcripts.** Antlings stores only auth data, an event log for replay, and flags such as archived or pinned. Deleting a session removes both.
- **One process per running session.** Each running session is a Claude Code process of about 200 MB, so `ANTLINGS_MAX_SESSIONS` defaults to 2. Idle sessions are closed and resumed on the next message.
- **Logins happen in the browser.** `server/src/connections/` runs `gh auth login --web` or `claude auth login` as the service user, one at a time, and passes only a login URL, a device code and a phase to the page. A pasted Claude code goes to the child's stdin. The page polls `GET /api/connections` while a login runs. A pasted API key is encrypted in the `settings` table, and the SDK environment reads the stored mode and key before the env file.
- **Attachments live outside the project folder.** Uploads are saved as `<dataDir>/uploads/<sessionId>/<uuid>.<ext>` with the original name kept only as metadata. Limits: 5 MB per file, 5 files per message, 200 MB per session; unsent files are deleted after 1 hour and a session's files go with the session. Images up to 5 MB go to Claude inline (20 MB per message at most), the rest as paths. The event log keeps file names and sizes, never the bytes.
- **The backend binds to 127.0.0.1.** A reverse proxy such as Caddy provides TLS.
- **Sprites are code, not images.** The ants are drawn on a 32x28 canvas and scaled by whole numbers. Every state also has a text label, and animation stops when `prefers-reduced-motion` is set.
- **Security model.** See [ADR 0002](adr/0002-authentication-and-trust-boundary.md) for sign-in, step-up checks, lockout and the trust boundary, and [ADR 0003](adr/0003-claude-login-terms.md) for API key versus subscription login.

## Decision records

| ADR | Topic |
|---|---|
| [0001](adr/0001-agent-sdk-backend.md) | Build on the Claude Agent SDK |
| [0002](adr/0002-authentication-and-trust-boundary.md) | Authentication and trust boundary |
| [0003](adr/0003-claude-login-terms.md) | Claude login and terms |
| [0004](adr/0004-stack.md) | Stack |

Observed behaviour of the SDK is in [sdk-notes.md](sdk-notes.md).
