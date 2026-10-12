# Antlings

A web UI for Claude Code on your Linux VPS. Each session has a lead ant, and each subagent is a worker ant at its own desk.

Status: design phase. No application code yet. See [docs/PLAN.md](docs/PLAN.md).

## What it does

- Start, resume, archive and delete Claude Code sessions from a browser, including a phone.
- Pick the folder, model, effort and permission mode for each new session.
- Approve or deny tool use from the page.
- Watch subagents work, read their reports, and resume them.
- Show context window usage per session and plan usage limits.
- Sign in with a passkey, or a password plus a one-time code.

## Preview the design

```bash
cd design
python -m http.server 8765
# open http://127.0.0.1:8765/mockup.html
```

The mockup uses fake data. It has no server.

## Layout

| Path | Contents |
|---|---|
| `docs/PLAN.md` | Goals, scope, phases, acceptance criteria, risks |
| `docs/sdk-notes.md` | Agent SDK behavior observed on the VPS |
| `docs/adr/` | Decision records |
| `design/mockup.html` | Clickable mockup with ant characters |
| `spikes/sdk-spike.mjs` | The script that produced `docs/sdk-notes.md` |
