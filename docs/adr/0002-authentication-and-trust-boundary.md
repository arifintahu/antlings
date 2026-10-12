---
title: "ADR 0002: Authentication and trust boundary"
status: proposed
date: 2026-10-12
tags: [antlings, adr, security]
related: [PLAN, 0001-agent-sdk-backend]
---

# ADR 0002: Authentication and trust boundary #antlings #adr #security

## Context

The page is public on a domain. A signed-in user can make an agent run shell commands on the VPS. On this VPS the `ubuntu` user has passwordless sudo, so an agent running as `ubuntu` can become root. Postgres and Redis listen on all interfaces, and `ufw` is inactive.

CloudDesktop used a 24-hour JWT in a cookie. It cannot be revoked before it expires. Its WebSocket check accepted a ticket or a token and did not look at the Origin header.

## Decision

1. One owner account. No sign-up page. No password reset by email. The owner resets access from an SSH session.
2. Sign-in with a passkey (WebAuthn). Fallback: password (argon2id) plus a one-time code (TOTP). A second factor is always required.
3. Sessions live on the server and can be revoked. The cookie is HttpOnly, Secure and SameSite=Strict. Idle timeout is configurable, default 12 hours. A "sign out everywhere" button clears all of them.
4. State-changing requests carry a CSRF token. WebSocket upgrades check the Origin header and a one-time ticket.
5. Rate limit sign-in at Caddy and in the app. Five failures from one address block that address for 15 minutes. Failures are written to a log that `fail2ban` can read.
6. Ask for the passkey or code again before: starting a session in Bypass mode, starting a session in the home folder itself, deleting a session.
7. The agent runs as a dedicated `antlings` user with no sudo. The folder picker is limited to that user's home, hides dot-folders, resolves real paths and rejects `..`.
8. Write an audit log of sign-ins, approvals, mode changes and deletions. Send a push notification on every new sign-in.
9. Optional extra layer: Cloudflare Access in front of Caddy.

## Alternatives considered

- Password only: weak for an account that equals shell access.
- JWT only: cannot be revoked.
- External identity provider only: adds a dependency that holds the keys to the VPS. Kept as the optional extra layer.
- Tailscale only: removes the public page, which the owner wants to keep.

## Consequences

- The `antlings` user needs its own Claude login, or a shared configuration folder with strict permissions. Check the subscription terms for this setup.
- Passkey setup needs a one-time command on the server console.
- Step-up prompts add friction for Bypass mode and deletion. That friction is the purpose.
- Open items outside the app: remove passwordless sudo from `ubuntu` if possible, close Postgres and Redis to the internet.
