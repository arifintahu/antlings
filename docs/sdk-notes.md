---
title: Agent SDK notes
status: observed
created: 2026-10-12
tags: [antlings, sdk, notes]
related: [PLAN, 0001-agent-sdk-backend]
---

# Agent SDK notes #antlings #sdk

Observed on the VPS on 2026-10-12 with `@anthropic-ai/claude-agent-sdk` 0.3.296 and Claude Code 2.1.287 (`/usr/bin/claude`, Ubuntu 24.04, Node 24). The script is `spikes/sdk-spike.mjs`. The run used three short turns and cost about $0.18 of estimated API value.

## Confirmed

| Need | Call or event | Observed |
|---|---|---|
| Start a session | `query({ prompt: asyncIterable, options })` | Streaming input works. `cwd`, `model`, `effort`, `permissionMode` are accepted. |
| Use the installed binary | `pathToClaudeCodeExecutable: '/usr/bin/claude'` | Works. The SDK installed with `--omit=optional` (57 MB). |
| Model list | `supportedModels()` | Fields: `value`, `resolvedModel`, `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsAutoMode`. Values: `default`, `opus`, `fable`, `sonnet`, `haiku`, plus pinned versions. |
| Switch model | `setModel('sonnet')` | The next `init` message showed `claude-sonnet-5-5`. `modelUsage` listed both models. |
| Switch mode | `setPermissionMode('plan')` | The next `init` message showed `plan`. |
| Switch effort | `applyFlagSettings({ effortLevel: 'medium' })` | Accepted. The effect was not observed. |
| Context window | `getContextUsage({ detail: 'summary' })` | Fields: `model`, `total_tokens`, `raw_max_tokens`, `percentage`, `categories[]` with `kind` of `used`, `free` or `deferred`. A new Haiku session read 12% (about 22k tokens of tools). |
| Plan usage | `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` | Returned `subscription_type`, `rate_limits.five_hour` and `seven_day` with `utilization` (0 to 100) and `resets_at`. |
| Plan usage push | `rate_limit_event` | Carries `unifiedWindows` with `utilization` as a fraction (0.5 means 50%). Convert before comparing with the call above. |
| Account | `accountInfo()` | Keys: `email`, `organization`, `subscriptionType`, `apiProvider`. Never log the values. |
| Subagent start | `task_started` | `task_type: local_agent`, `subagent_type`, `description`, `is_backgrounded`. |
| Subagent end | `task_updated`, `task_notification` | `usage: { total_tokens, tool_uses, duration_ms }`, `status`. |
| Subagent messages | `assistant` and `user` with `parent_tool_use_id` | Extra keys `subagent_type`, `task_description`. |
| Stop one subagent | `query.stopTask(taskId)` | In the type definitions. Not run. A `task_notification` with `stopped` follows. |
| List and read sessions | `listSessions`, `getSessionInfo`, `getSessionMessages` | In the type definitions. Not run. |
| Subagent transcripts | `listSubagents`, `getSubagentMessages` | In the type definitions. Not run. |
| Archive | `tagSession(id, 'archived')` | In the type definitions. There is no archive call. |
| Delete | `deleteSession(id)` | Removes `{id}.jsonl` and the `{id}/` subagent folder. |

## Behavior to design around

- A `system:init` message arrives at the start of every turn. It does not mean a new session.
- `allowedTools: ['Agent']` auto-approves the tool and skips `canUseTool`. The SDK prints `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. Use a `PreToolUse` hook when every call must reach the UI.
- `persistSession: false` still created `~/.claude/projects/-tmp-cc-spike-cwd/` with a subagent stub. Clean it up after tests.
- `task_progress` did not fire for a subagent that finished in 2 seconds.
- Memory: one session added about 200 MB resident. One subagent added about 33 MB. One run only.
- The login used was a Max subscription (`subscription_type: max`). With an API key `rate_limits_available` is false.
- `omitClaudeMd`, `settingSources: []` and similar options change what the session loads. The spike used `settingSources: []`.

## Not tested yet

- `stopTask`, `listSessions`, `getSessionMessages`, `listSubagents`, `getSubagentMessages` against real data.
- `task_progress` with a longer subagent, and `agentProgressSummaries`.
- `resume` after a restart, and across folders (the docs say lookup spans folders from Claude Code 2.1.223).
- Two sessions at once, and memory under that load.
