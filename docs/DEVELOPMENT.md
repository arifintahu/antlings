# Development

You need Node 24 or newer and [pnpm](https://pnpm.io) 9. You do not need a Claude login: the dev server and the tests run against a fake agent, so nothing is spent.

```bash
git clone https://github.com/arifintahu/antlings.git
cd antlings
pnpm install
pnpm build        # builds the shared package the server imports
```

## Run the app against the fake agent

```bash
pnpm --filter @antlings/server exec tsx src/e2e/server.ts   # http://localhost:3199
```

This is the real app (real WebAuthn, sessions and static files) with a scripted agent and fake `gh` and `claude` CLIs. It serves the built web app, so run `pnpm build` again after changing UI code.

**First sign-in.** The page asks for a setup code. The fake server has no `antlings setup` command, so request one from its test route:

```bash
curl -s -X POST -H "Origin: http://localhost:3199" http://localhost:3199/__e2e/reset
```

The response holds a `code` (valid for 15 minutes, single use). The same call resets sign-in state and returns the Connections page to its signed-out state, which is how you see the setup flow again. Passkey registration uses the browser's real WebAuthn, so use Chrome on `localhost`.

The `/__e2e` routes have no authentication. They exist only in this harness and never in the production server.

### Hot reload for UI work

The Vite dev server proxies `/api`, `/ws` and `/health` to port 3100. Start the fake server there, then Vite:

```bash
E2E_PORT=3100 pnpm --filter @antlings/server exec tsx src/e2e/server.ts   # PowerShell: $env:E2E_PORT=3100
pnpm --filter @antlings/web dev                                           # prints the URL, usually http://localhost:5173
```

## Run against real Claude Code

```bash
pnpm build
cp .env.example .env                  # then add ANTHROPIC_API_KEY=... to it
node server/dist/cli.js gen-env       # prints three secret lines; paste them over the empty ANTLINGS_SECRET_KEY, ANTLINGS_VAPID_PUBLIC and ANTLINGS_VAPID_PRIVATE lines in .env
pnpm --filter @antlings/server dev    # http://localhost:3100
```

In a second terminal, print the one-time setup code:

```bash
ANTLINGS_ENV_FILE=../.env pnpm --filter @antlings/server exec tsx src/cli.ts setup
```

Open the page, enter the code and register your passkey. Use a key with a spend cap.

## Checks

```bash
pnpm lint            # eslint and prettier
pnpm test            # server, shared and web unit tests, plus svelte-check
pnpm build
pnpm e2e             # Playwright against the fake agent, uses the installed Chrome
```

The opt-in live test calls the real SDK with Haiku and is capped at 0.10 USD:

```bash
ANTLINGS_LIVE=1 pnpm --filter @antlings/server test
```

The browser tests run axe in light and dark themes. Keep them passing when you change the interface.

## Screenshots

```bash
pnpm --filter @antlings/web e2e showcase    # writes docs/screens/
```

## Layout

| Path | Contents |
|---|---|
| `server/` | Fastify backend: auth, sessions, WebSocket protocol, folder picker, push |
| `web/` | Svelte 5 app, ant sprites (`src/ants/draw.ts`), PWA files, Playwright tests (`e2e/`) |
| `shared/` | Protocol types and request schemas used by both |
| `deploy/` | systemd unit, Caddy snippet, fail2ban files, installer, release build, smoke tests |
| `docs/` | [Architecture](ARCHITECTURE.md), [runbook](RUNBOOK.md), [SDK notes](sdk-notes.md), [decision records](adr/) |

The sprite golden tests in `web/src/ants/` pin the art by hash (`golden.json`). Change the art only on purpose. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the pull request checklist.
