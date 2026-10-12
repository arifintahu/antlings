---
title: "ADR 0001: Build the backend on the Claude Agent SDK"
status: proposed
date: 2026-10-12
tags: [antlings, adr]
related: [PLAN, sdk-notes]
---

# ADR 0001: Build the backend on the Claude Agent SDK #antlings #adr

## Context

Antlings needs sessions, streamed output, approvals, subagent events, model and mode switching, context and plan usage, and session management. The VPS has 2 GB of RAM.

Options considered:

1. Run the `claude` CLI in a pseudo-terminal and show it with xterm.js.
2. Use the Agent SDK `query()` with streaming input.
3. Adopt an existing open-source web UI for Claude Code.

## Decision

Use option 2. The backend is a Node service that holds one streaming `query()` per active session and forwards typed events to the browser.

## Why

- Option 1 returns screen text. Approvals, subagents and meters would need text parsing.
- Option 3 projects found in a short search were small and young. None was checked for maintenance, and none matched the ant view or the approval flow.
- Option 2 exposes every needed feature as a typed call or event. The spike confirmed this on the VPS, see [[sdk-notes]].

## Consequences

- The VPS needs the `claude` binary and a login. Version 2.1.287 is installed.
- The SDK version is pinned. Upgrades are tested against the spike script first.
- The plan usage call is marked experimental. It sits behind one adapter, and the UI shows "unavailable" when it fails.
- Each running session costs about 200 MB, so the number of running sessions is capped.
- A subscription login behind a self-hosted web app needs a terms check before Phase 1.
