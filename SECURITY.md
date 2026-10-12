# Security policy

Antlings gives a browser control over an AI agent that runs commands on your server, so security reports are taken seriously.

## Report a vulnerability

Please do **not** open a public issue. Use GitHub's private reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and the version (`/api/status` or the Security page shows it).

You can expect a first answer within a few days. Antlings is maintained by one person, so fixes are made on a best-effort basis.

## Scope

In scope: the sign-in and session code, the Origin and CSRF checks, the WebSocket ticket flow, the folder picker's path checks, the installer and release scripts in `deploy/`, and the web app.

Known and documented limits, not treated as vulnerabilities: the agent runs as the same Unix user as the service, and can reach services on `127.0.0.1`. See [ADR 0002](docs/adr/0002-authentication-and-trust-boundary.md) and "Known limits" in the [runbook](docs/RUNBOOK.md).

## Hardening checklist for operators

- Use a dedicated Anthropic API key with a spend cap.
- Keep Bypass mode rare.
- Keep the server patched and put your own address in the fail2ban `ignoreip` list.
- Never paste `/etc/antlings/antlings.env` or any key into an issue.
