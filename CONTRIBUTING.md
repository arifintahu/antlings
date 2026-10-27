# Contributing

Thanks for helping. Antlings is a small project with one maintainer, so small, focused pull requests are easiest to review.

## Setup

You need Node 24 or newer and pnpm 9.

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
pnpm e2e        # Playwright against a fake agent; needs Chrome installed
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full setup. You do not need a Claude login to develop. The tests and `pnpm --filter @antlings/server exec tsx src/e2e/server.ts` use a fake agent. The live SDK test is opt-in (`ANTLINGS_LIVE=1`) and spends a few cents.

## Pull requests

- Branch off `main`. Use [Conventional Commits](https://www.conventionalcommits.org) for titles: `feat(web): ...`, `fix(server): ...`, `docs: ...`.
- Say what changed and why, and how you checked it.
- Write a failing test first for bug fixes. Always test authentication, session handling, folder-picker path checks, and anything that deletes data.
- `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm e2e` should pass.
- Do not commit secrets, server addresses or keys. Use placeholders such as `ants.example.com`.

## Guidelines

- Keep the ant sprites in code (`web/src/ants/draw.ts`). The golden hash tests (`web/src/ants/golden.json`) fail if the art changes. If you change it on purpose, update the hashes in that file.
- Every state needs a text label as well as an animation, and `prefers-reduced-motion` must be respected.
- Interface changes should keep the axe checks in the browser tests passing, in light and dark.
- Plain wording in docs. Say what a thing does, with numbers where they exist.

## Decisions

Larger design choices are written down as short records in [docs/adr/](docs/adr/). If you propose a change to authentication, the trust boundary or the stack, open an issue first.

## Screenshots

The README screenshots come from `pnpm --filter @antlings/web e2e showcase`, which writes into `docs/screens/`.
