---
title: Decisions log
tags: [antlings, decisions]
---

# Decisions #antlings

| Date | Choice | Reason |
|---|---|---|
| 2026-10-12 | Launcher values all empty: DOMAIN empty, DEPLOY=no, AUTH_MODE default, STACK default | Defaults from BUILD-PROMPT |
| 2026-10-12 | `AUTH_MODE=apikey` default, subscription behind a flag | Terms say Agent SDK products should use API keys, see [[0003-claude-login-terms]] |
| 2026-10-12 | M7 skipped | DEPLOY=no |
| 2026-10-12 | Branch `build/v0.1` created from existing `main` (3 commits already present) | Initial commit already existed |
| 2026-10-12 | `@node-rs/argon2` instead of `argon2` | Prebuilt binaries, no compiler on VPS |
