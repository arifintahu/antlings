---
title: "ADR 0004: Stack"
status: accepted
date: 2026-10-12
tags: [antlings, adr, stack]
related: [PLAN, 0001-agent-sdk-backend]
---

# ADR 0004: Stack #antlings #adr

## Decision

Accept the stack in [[PLAN]]: Node, TypeScript (strict), pnpm workspace (`server`, `web`, `shared`), Fastify, `ws`, `better-sqlite3`, `@simplewebauthn/server`, `otpauth`, Svelte 5 + Vite, Vitest, Playwright.

Changes from the plan:

- Password hashing uses `@node-rs/argon2` (prebuilt binaries, no compiler). `better-sqlite3` also ships prebuilt binaries for Linux x64.
- Build machine runs Node 22.18; the VPS runs Node 24. `engines` is `>=22`; code uses only APIs present in both.
- zod validates every inbound message and body. It lives in `shared/`.

## Consequences

- No dependency needs a compiler on the VPS. If a prebuilt binary is missing at install time, that is a blocker (see BLOCKERS.md).
