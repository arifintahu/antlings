# Antlings

Self-hosted web UI for Claude Code on a Linux VPS. Lead ant per session, worker ant per subagent. Status: design phase, no application code yet.

Read first: [docs/PLAN.md](docs/PLAN.md), [docs/sdk-notes.md](docs/sdk-notes.md), [docs/adr/](docs/adr/).

## Rules for this project

- Package manager: pnpm. Language: TypeScript on Node 24 (proposed, confirm in Phase 0).
- Write tests first for bugs. Always test authentication, session handling, folder-picker path checks and anything that deletes data.
- Run the formatter, linter and tests before saying work is done, and report the real output.
- Commit and push only when asked. Branch off `main`. Conventional Commits. No AI attribution in commits or PRs.
- Docs use YAML frontmatter, wikilinks between docs (double square brackets around the file name), and `#tags`.
- Plain wording in docs. Say what a thing does, with numbers where they exist.

## The VPS

- Host and SSH user are in `D:\code\memory.md` (outside this repo). Use `$VPS_HOST` in files that are committed. Never write the address, keys, tokens or the Claude login into the repo.
- Ask before changing anything on the VPS. Read-only inspection is fine. Tests go in `/tmp` and get deleted afterwards.
- The VPS is small (2 vCPU, 2 GB) and shared with other services. Check free memory before starting load.
- `~/.claude/.credentials.json` on the VPS holds a login. Do not read it. `accountInfo()` returns an email, so log only its key names.

## Design

- `design/mockup.html` is the visual reference. Preview with `python -m http.server` from `design/`.
- Keep the ant sprites in code (32x28 canvas, whole-number scaling). Do not add image assets without asking.
- Every state needs a text label as well as an animation. Respect `prefers-reduced-motion`.

## Open decisions

Stack confirmation, the subscription terms check, and the two proposed ADRs. See the risk table in the plan.
