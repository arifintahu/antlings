# ADR 0002: Authentication and trust boundary

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

## Threat model: what was built and what remains (2026-10-12, v0.1)

Asset: a shell on the VPS, reached through the agent. An authentication bypass is remote code execution.

### Built, with tests

| Threat | Control | Test |
|---|---|---|
| Unauthenticated access | Default-deny hook. Only routes marked `public` skip the session check. The raw URL is never used to decide (encoded paths such as `/%61pi/me` are covered). | `route protection` enumerates every route and fails if the public list changes |
| Stolen or guessed password or code | Argon2id password, TOTP with replay guard, 3 tries per password step, lockout of 5 failures per address (IPv4 address or IPv6 /64) for 15 minutes, global brake at 100 failures, attempts counted before they are checked | `lockout` tests, including a 30-request burst |
| Brute force of the setup code | 40-bit code, hashed, 15 minutes, single use, counted by the same lockout | `first run` tests |
| CSRF and cross-site requests | Exact Origin check on every state-changing request, CSRF token compared in constant time, SameSite=Strict, `__Host-` cookie, no CORS headers | `sign-in, cookie and csrf`, `cross-origin access` |
| Session theft | Server-side sessions, only a hash stored, revocation on the next request, 12 h idle timeout and 30-day cap, sign out per device and everywhere | session tests |
| Abuse of a stolen session | Step-up (passkey with user verification, or TOTP) within 5 minutes for: Bypass mode, a session in the home folder, deleting a session, adding or removing a passkey, changing the password, changing settings, sign out everywhere | `step-up` tests, REST and WebSocket |
| WebSocket hijack | Exact Origin, single-use 30 s ticket, session re-checked every 15 s and on each message, 256 KB frame limit, every message parsed with a schema | `ws.test.ts` |
| A signed-in session reaching a shell | The session terminal is a shell as the service user with no approvals and no step-up (the owner's choice). Controls: the session check on every route, exact Origin and a single-use 30 s ticket on `/ws/term`, the session re-checked every 15 s and on each input, a folder read from the stored session and never from the client, an allowlisted shell environment (no `ANTLINGS_*`), 4 running shells per session and 12 in total, audit rows for open and close, and no terminal input or output in any log | `terminals/routes.test.ts`, `terminals/ws.test.ts`, `terminals/registry.test.ts` |
| Path escape from the folder picker | Real-path resolution, `..` and absolute paths rejected, symlinks that leave home hidden and refused, UUID-only session ids | `folders.test.ts` (also run on Linux, Node 24) |
| Secrets leaking | The agent's shell gets an allowlisted environment (no `ANTLINGS_*`). Logs and audit entries are redacted. Log lines cannot be forged with line breaks. | `hardening.test.ts` |
| XSS and script injection | CSP without `unsafe-inline`, no `{@html}`, text rendering only, no CSP violation in the end-to-end run | e2e `afterEach` check |
| Dependency flaws | `pnpm audit` clean, exact versions pinned | run at M5 and in the handoff |

### Remaining risks

1. **The agent and the service run as the same Unix user (`antlings`).** An agent that is told to attack the service can read `antlings.db` and the env file, edit the database, or call `antlings reset-access`. Step-up and approvals protect against a stolen browser session. They do not protect against a prompt-injected agent in Bypass mode. Mitigation for v0.2: run the service as its own user, keep the agent in a second user, and talk over a unix socket. Until then, keep Bypass mode rare and read "Known limits" in [the runbook](../RUNBOOK.md). The session terminal gives a signed-in browser the same reach without the agent in between: it is a shell as `antlings`, so it can read the same files. If the service moves to its own user, the terminal must run as the other user.
2. **Any local process can reach `127.0.0.1:3100`** and send its own `X-Forwarded-For` and `Origin`. A shell on the VPS is already a larger problem than this.
3. **Behind Cloudflare** the client address is the edge address unless Caddy is configured with `trusted_proxies`. Five failures from an attacker would then lock out everyone. Do not add Cloudflare without that setting.
4. **Passkeys are discoverable and require user verification.** A device without a screen lock cannot be used. That is intended.
5. **Push payloads** go through the browser vendor's push service. They carry the tool name only, never input or output.
6. **Passwordless sudo for `ubuntu`, Postgres and Redis on all interfaces, inactive `ufw`** are outside this repository. See the plan's risk table.
