---
title: "ADR 0003: Claude login and terms"
status: accepted
date: 2026-10-12
tags: [antlings, adr, terms]
related: [PLAN, 0001-agent-sdk-backend, 0002-authentication-and-trust-boundary]
---

# ADR 0003: Claude login and terms #antlings #adr #terms

## Context

Antlings runs Claude Code through the Agent SDK on the owner's VPS. The question: may it use the owner's Claude subscription login?

Source: https://code.claude.com/docs/en/legal-and-compliance (fetched 2026-10-12).

Relevant sentences:

- "Developers building products or services ... including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider."
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- Allowed: "an end user [signing] in to the unmodified Claude Code binary with their own Claude subscription".

## Decision

1. Antlings never handles Claude credentials. The owner signs in on the server with the unmodified `claude` binary. Antlings only calls the SDK.
2. Default `ANTLINGS_AUTH_MODE=apikey`: the service passes `ANTHROPIC_API_KEY` from its env file. This is the documented path for Agent SDK products.
3. `ANTLINGS_AUTH_MODE=subscription` exists behind a flag that is off by default. It uses the login already stored for the `antlings` user. It is for one owner, personal use. The owner takes the terms risk.
4. Plan usage meter: shown only when the SDK reports `rate_limits_available`. With an API key it shows "unavailable".

## Fallback

If subscription use is judged not allowed, set `apikey` and lose only the plan usage meter. No other feature depends on the subscription.

## Consequences

- Single owner, no sign-up, no sharing: stays inside "ordinary, individual usage".
- The terms can change. Re-read before enabling `subscription`.
