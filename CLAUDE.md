# Antlings

Self-hosted web UI for Claude Code on a Linux server. Lead ant per session, worker ant per subagent. Svelte 5 web app, Fastify backend, Claude Agent SDK.

Start with [README.md](README.md), then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/sdk-notes.md](docs/sdk-notes.md) and [docs/adr/](docs/adr/).

## Commands

- `pnpm install`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm e2e` (Playwright against a fake agent, uses installed Chrome).
- Fake-agent server: `pnpm --filter @antlings/server exec tsx src/e2e/server.ts` (port 3199).
- README screenshots: `pnpm --filter @antlings/web e2e showcase` (writes `docs/screens/`).
- Live SDK test, opt-in and capped at 0.10 USD: `ANTLINGS_LIVE=1 pnpm --filter @antlings/server test`.

## Rules for this project

- Package manager: pnpm. Language: TypeScript on Node 22 or newer (24 on the server).
- Write tests first for bugs. Always test authentication, session handling, folder-picker path checks and anything that deletes data.
- Run the formatter, linter and tests before saying work is done, and report the real output.
- Branch off `main`. Conventional Commits. Commit and push only when asked.
- Docs are plain Markdown with relative links. Say what a thing does, with numbers where they exist.

## Never commit

- Server addresses, SSH users, domains that belong to a person, keys, tokens, `.env` files, or any Claude login data. Use placeholders such as `ants.example.com` and `$VPS_HOST` in committed files.
- Local machine paths or notes from outside this repository.

## Working on a server

- Ask before changing anything on a real server. Read-only inspection is fine.
- Never read `~/.claude/.credentials.json`. `accountInfo()` returns an email, so log only its key names.
- `deploy/deploy.sh` is the one-command deploy. Pass the target through `VPS_SSH` and `DOMAIN` in your shell, not in a file.

## Design

- The sprite golden tests in `web/src/ants/` pin the art by hash (`golden.json`). Change the art only on purpose.
- Keep the ant sprites in code (32x28 canvas, whole-number scaling). Do not add image assets for them.
- Every state needs a text label as well as an animation. Respect `prefers-reduced-motion`.
- Interface changes must keep the axe checks in the browser tests passing, in light and dark.
