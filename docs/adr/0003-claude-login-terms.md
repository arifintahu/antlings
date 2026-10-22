# ADR 0003: Claude login and terms

## Context

Antlings runs Claude Code through the Agent SDK on the owner's VPS. The question: may it use the owner's Claude subscription login?

Source: https://code.claude.com/docs/en/legal-and-compliance (fetched 2026-10-12).

Relevant sentences:

- "Developers building products or services ... including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider."
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- Allowed: "an end user [signing] in to the unmodified Claude Code binary with their own Claude subscription".

## Decision

1. Antlings never reads Claude's credential files. The owner signs in with the unmodified `claude` binary. Antlings only calls the SDK.
2. Default `ANTLINGS_AUTH_MODE=apikey`: the service passes `ANTHROPIC_API_KEY` from its env file. This is the documented path for Agent SDK products.
3. `ANTLINGS_AUTH_MODE=subscription` exists behind a flag that is off by default. It uses the login already stored for the `antlings` user. It is for one owner, personal use. The owner takes the terms risk.
4. Plan usage meter: shown only when the SDK reports `rate_limits_available`. With an API key it shows "unavailable".

## Fallback

If subscription use is judged not allowed, set `apikey` and lose only the plan usage meter. No other feature depends on the subscription.

## Consequences

- Single owner, no sign-up, no sharing: stays inside "ordinary, individual usage".
- The terms can change. Re-read before enabling `subscription`.

## Amendment 2026-10-22: signing in from the UI

The Connections page lets the owner connect without SSH. What changes:

- **Subscription sign-in is relayed, not reimplemented.** Antlings starts `claude auth login --claudeai` as the service user, shows the OAuth link the binary prints, and writes the code the owner pastes to the binary's stdin. The binary does the sign-in and stores its own credentials. Antlings reads only `claude auth status --json` (`loggedIn`, `authMethod`, `subscriptionType`), never the credential file or the account email.
- **An API key can be pasted.** It is checked against the models endpoint, stored encrypted in the database and passed to the SDK as `ANTHROPIC_API_KEY`. Antlings never returns or logs it. The key and the env file are readable by the agent (same Unix user), as before.
- **The terms acknowledgement moves into the UI.** Switching to `subscription` mode needs a ticked box that links to Anthropic's terms, and the time is stored. `ANTLINGS_SUBSCRIPTION_OK=1` still works for env-file installs. `apikey` remains the default.
- Every connect, disconnect, key change and mode change needs a fresh check and is audited.
