# ADR 0004: Stack

## Decision

Accept this stack: Node, TypeScript (strict), pnpm workspace (`server`, `web`, `shared`), Fastify, `ws`, `better-sqlite3`, `@simplewebauthn/server`, `otpauth`, Svelte 5 + Vite, Vitest, Playwright.

Choices made while building:

- Password hashing uses `@node-rs/argon2` (prebuilt binaries, no compiler). `better-sqlite3` also ships prebuilt binaries for Linux x64.
- Build machine runs Node 22.18; the VPS runs Node 24. `engines` is `>=22`; code uses only APIs present in both.
- zod validates every inbound message and body. It lives in `shared/`.

## Consequences

- No dependency needs a compiler on the VPS. If a prebuilt binary is missing at install time, the install fails instead of falling back to a compiler.
