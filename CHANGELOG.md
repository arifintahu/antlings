# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.5.1] - 2026-10-28

### Fixed

- On a phone, the attach button opened only the file browser, so photos could not be picked. The file picker now names image, PDF and text types before the file extensions, so iOS and Android offer the photo library and camera. HEIC is left out on purpose, so iOS converts photos to JPEG.

## [0.5.0] - 2026-10-28

### Added

- Paste images and attach files in the session input: a paperclip button, Ctrl+V for images, and drag and drop. Files show as chips above the input with progress, size and errors. Each file is at most 5 MB, with up to 5 per message and 200 MB per session. Allowed types are PNG, JPEG, GIF, WebP, PDF, and text or code files; the content is checked, not just the extension, and SVG is refused.
- Images go to Claude as images (up to 5 MB each and 20 MB per message). Other files are saved on the server and Claude reads them by path. Files live in `<dataDir>/uploads/<sessionId>/`, outside the project folder, and are deleted with the session. Files that are never sent are deleted after 1 hour. The event log keeps file names and sizes, not the bytes.
- New routes `POST`, `GET` and `DELETE` on `/api/sessions/:id/uploads`, and an `uploads` table in the database.

### Fixed

- The session list reloads when the WebSocket reconnects, so a list that failed to load while the server stalled no longer stays empty.

### Known limits

- Whether Claude reads the uploads folder without a permission prompt, and the API's image size limits, were seen working on one deployment but not checked by the opt-in live test (the login had expired).
- A file name over 120 characters loses its extension and is reported as an unsupported type.
- Parallel uploads close to the 200 MB session limit can go over it by up to 25 MB.
- A session history rebuilt from Claude's own transcript shows the path list and no attachment chips.

## [0.4.0] - 2026-10-27

### Added

- The sidebar footer shows the running version ("About · v0.4.0"), read from the server's `package.json` through `GET /api/status`. It opens an About dialog with the version, a short description, links to the release notes for that version and to the source, and the license.

### Security

- Updated `fastify` to 5.12.6 and `body-parser` to 2.4.0. Both upstream releases are marked as security releases. `qs` moved to 6.16.1 with `fastify`.

## [0.3.0] - 2026-10-27

### Added

- Session terminal: a pty shell per session, started in the session's folder, shown beside the chat (desktop) or behind a Chat | Terminal switch with a key bar (below 900 px). Up to 4 running shells per session and 12 in total, about 5,000 lines of scrollback replayed on reattach. Shells survive a browser reload and end on archive, delete, tab close or server restart. New routes `/api/sessions/:id/terminals` and a WebSocket at `/ws/term`. Open and close are audited.
- The page's CSP now carries a per-response nonce for `style-src` (still no `unsafe-inline`), because xterm.js creates `<style>` elements.

### Changed

- The release build installs `python3`, `make` and `g++` in the build container to compile `node-pty`.

### Fixed

- A session that the idle reaper closed before its first message could not be used again: the next message tried to resume a transcript that did not exist ("No conversation found") and archive failed too. It now starts the session instead of resuming it when there is no transcript.
- A numbered list with blank lines between its items was shown as separate lists, so every item read "1.". The list now keeps its numbering.

### Known limitations

- A shell's `PATH` comes from the service user's login shell, so `node` and `pnpm` there may differ from the service's own Node. On the reference VPS the shell found Node 20 and no `pnpm`.
- The terminal is a direct shell as the service user and needs no passkey step. Environment filtering keeps `ANTLINGS_*` and API keys out of the shell's environment but is not a boundary: the shell can still read the env file.
- Archiving a session shows no message in the page when the server refuses it.

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

[Unreleased]: https://github.com/arifintahu/antlings/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/arifintahu/antlings/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/arifintahu/antlings/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/arifintahu/antlings/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/arifintahu/antlings/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/arifintahu/antlings/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/arifintahu/antlings/releases/tag/v0.1.0
