# Antlings

A web UI for Claude Code on your Linux VPS. Each session has a lead ant, and each subagent is a worker ant at its own desk.

Status: v0.1 built and tested locally. Not deployed. Start with [docs/HANDOFF.md](docs/HANDOFF.md).

## What it does

- Start, resume, archive and delete Claude Code sessions from a browser, including a phone.
- Pick the folder, model, effort and permission mode for each new session.
- Approve or deny tool use from the page.
- Watch subagents work, read their reports, and stop one.
- Show context window usage per session and plan usage limits.
- Sign in with a passkey, or a password plus a one-time code. Passkey, step-up and lockout rules are in [docs/adr/0002-authentication-and-trust-boundary.md](docs/adr/0002-authentication-and-trust-boundary.md).

## Develop

Needs Node 22 or newer and pnpm 9.

```bash
pnpm install
pnpm lint && pnpm test && pnpm build
pnpm e2e            # Playwright against a fake agent; uses the installed Chrome
```

Run it locally with the fake agent (no Claude login needed):

```bash
pnpm --filter @antlings/server exec tsx src/e2e/server.ts   # http://localhost:3199
```

Run it for real (uses your Claude login or API key and spends plan usage):

```bash
cp .env.example .env   # set ANTLINGS_SECRET_KEY (see the comment in the file)
pnpm build && pnpm --filter @antlings/server dev   # http://localhost:3100
pnpm --filter @antlings/server exec tsx src/cli.ts setup   # prints the setup code
```

Opt-in live SDK test (Haiku, capped at 0.10 USD): `ANTLINGS_LIVE=1 pnpm --filter @antlings/server test`.

## Layout

| Path | Contents |
|---|---|
| `server/` | Fastify backend: auth, sessions, WebSocket protocol, folder picker, push |
| `web/` | Svelte app, ant sprites (`src/ants/draw.ts`), PWA files, Playwright tests (`e2e/`) |
| `shared/` | Protocol types and request schemas shared by both |
| `deploy/` | systemd unit, Caddy snippet, fail2ban files, installer, release build, smoke tests |
| `docs/PLAN.md` | Goals, scope, phases, acceptance criteria, risks |
| `docs/HANDOFF.md` | What was built, what to do next, known gaps |
| `docs/RUNBOOK.md` | Operating the service on the VPS |
| `docs/adr/` | Decision records |
| `docs/DECISIONS.md`, `docs/PROGRESS.md`, `docs/BLOCKERS.md` | Build log |
| `design/mockup.html` | The visual reference |
| `spikes/sdk-spike.mjs` | The script that produced `docs/sdk-notes.md` |
