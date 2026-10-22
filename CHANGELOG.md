# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.2.0] - 2026-10-22

### Added

- Connections page: connect GitHub (device-flow sign-in through `gh`, `gh auth setup-git`, git name and email) and Claude (paste an API key, or relay the `claude` sign-in for subscription use) from the browser, with no SSH after install. Every change needs a fresh check and is audited.
- `deploy/install.sh` installs the GitHub CLI with `apt-get` (skip with `--no-gh`), and its next steps now point to the Connections page.
- A sidebar prompt ("Set up Claude and GitHub") shows until both are connected, then goes away. It reads `GET /api/connections/summary`, which is cached for a minute and starts Claude Code only in subscription mode.
- `ANTLINGS_GH_PATH` setting for a `gh` that is not on the service's `PATH`.

### Known limitations

- The relayed `claude auth login` sign-in was checked on Windows only. If it needs a terminal on your server, sign in with `sudo -u antlings -H claude login` or use an API key.

## [0.1.0] - 2026-10-13

First public release.

### Added

- Web UI for Claude Code through the Claude Agent SDK: start, resume, rename, pin, archive and delete sessions, with folder, model, effort and permission mode chosen per session.
- Streaming answers rendered as safe markdown, and approval cards that show the command, file content or diff before you approve or deny.
- Lead ant per session and worker ant per subagent, with state, current tool, tokens, log and final report. Stop one subagent, or send a follow-up through the lead.
- Context window, cost and plan usage meters.
- Installable PWA with a phone layout and Web Push when an approval is waiting.
- Sign-in with a passkey, or a password plus authenticator code. Server-side sessions, step-up checks before risky actions, a 15-minute lockout after repeated failures, an audit log, per-device sign-out and a Security page with server status.
- Event log with sequence numbers, so a page that reconnects replays what it missed.
- Deployment tooling: release build in Docker, an idempotent installer with checksum check, rollback and dry run, a hardened systemd unit, a Caddy site file, a fail2ban filter and jail, an uninstaller, and `deploy/deploy.sh` for one-command deploys.
- Documentation: README with deploy guide, runbook, architecture notes, four decision records, contributing and security policies.
- CI on pull requests: lint, build and test.

### Known limitations

- The agent runs as the same Unix user as the service, and can reach services on `127.0.0.1`. See [the runbook](docs/RUNBOOK.md#known-limits).
- Plan usage is shown only with a subscription login, and only after the first message.
- Web Push has not been tested on iOS home-screen installs.

[Unreleased]: https://github.com/arifintahu/antlings/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/arifintahu/antlings/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/arifintahu/antlings/releases/tag/v0.1.0
