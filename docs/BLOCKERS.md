---
title: Blockers and open items
tags: [antlings, blockers]
related: [PROGRESS, HANDOFF]
---

# Blockers #antlings

Nothing stopped the build. These items could not be finished or verified, and why.

| Item | What was tried | Status |
|---|---|---|
| M7 deploy and smoke test on the VPS | The launcher said `DEPLOY=no` and gave no authorization sentence. `CLAUDE.md` says to ask before changing the VPS, so the VPS was not contacted at all. | Skipped by design. The same checks ran in a Node 24 Linux container (`deploy/smoke.sh`, `deploy/container-test.sh`). |
| Plan usage meter with real data | One live run on this Windows machine (subscription login) returned `unavailable` from the experimental SDK call. | Adapter shows "unavailable". Check on the VPS with a subscription login before relying on it. |
| Long-running subagent events (`task_progress`) | Only recorded message shapes were tested. The live turns were two tiny Haiku turns without a subagent (10 live turns allowed, 2 used). | Open. Try one real long subagent after deploy. |
| Web Push on a real device, iOS home-screen install | Server and service worker are tested with a fake push service. No phone available to the build. | Open. |
| `fail2ban` jail on the real machine | The filter regex is tested against the real log line. `fail2ban-regex` and the jail were not run (fail2ban not installed here). | Open. Run `fail2ban-regex` on the VPS, see the runbook. |
| Caddy config validation | `caddy` is not installed on the build machine, so the snippet was not run through `caddy validate`. The installer validates before it reloads. | Open until the first install. |
| Service and agent share one Unix user | Spec asks for one user `antlings`. A second user needs a unix socket and a rework of the folder and login model. | Accepted risk for v0.1, see [[0002-authentication-and-trust-boundary]]. |
