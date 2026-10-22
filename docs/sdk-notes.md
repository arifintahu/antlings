# Agent SDK notes

Observed on the VPS on 2026-10-12 with `@anthropic-ai/claude-agent-sdk` 0.3.296 and Claude Code 2.1.287 (`/usr/bin/claude`, Ubuntu 24.04, Node 24). The run used three short turns and cost about $0.18 of estimated API value.

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
- `omitClaudeMd`, `settingSources: []` and similar options change what the session loads. The test run used `settingSources: []`.

## Not tested yet

- `stopTask`, `listSessions`, `getSessionMessages`, `listSubagents`, `getSubagentMessages` against real data.
- `task_progress` with a longer subagent, and `agentProgressSummaries`.
- `resume` after a restart, and across folders (the docs say lookup spans folders from Claude Code 2.1.223).
- Two sessions at once, and memory under that load.

## Added during the build (2026-10-12, SDK 0.3.296, Windows and Linux)

| Topic | Observed |
|---|---|
| Session id up front | `options.sessionId` takes a UUID, so Antlings creates the id before the first message. `options.resume` loads an existing one. |
| Approval request fields | `canUseTool(name, input, opts)`: `opts.toolUseID`, `opts.title` (full prompt sentence), `opts.agentID` (set inside a subagent), `opts.signal`. The result may also be `null`. |
| Linking an approval to an ant | The `tool_use` block arrives first with `parent_tool_use_id` of the Agent call. Antlings keeps a map from tool id to parent and sets `parentToolUseId` on the approval event. |
| Bypass mode | Needs `allowDangerouslySkipPermissions: true` next to `permissionMode: 'bypassPermissions'`. |
| Spend cap | `maxBudgetUsd` works as a per-process cap. The live test uses 0.10. |
| `rate_limit_event` | The typed fields are `rate_limit_info.rateLimitType`, `utilization` (fraction), `resetsAt` (epoch seconds). No `unifiedWindows` in the 0.3.296 types. |
| Plan usage in a live run | `usage_EXPERIMENTAL_...` reported unavailable in the live test on this Windows machine. The adapter returns `unavailable` on any failure or when `rate_limits_available` is false. |
| Size | Each platform package of the SDK (`claude-agent-sdk-linux-x64` and friends) carries a 250 MB `claude` binary. The release build removes them, because the VPS uses its own binary through `pathToClaudeCodeExecutable`. |
| Memory | Importing the SDK adds about 20 MB resident, so Antlings loads it on the first session. The `zod` v4 and `@simplewebauthn/server` imports cost about 16 and 15 MB; the latter is loaded on the first passkey request. |
| Live turns | A tiny Haiku turn plus `getContextUsage` finished in about 3 seconds. Closing a session and resuming it with a new manager worked (`resume: id`, same folder). The test cleans up the stub folder under `~/.claude/projects`. |
| `better-sqlite3` 13 | Ships prebuilt binaries for Linux, macOS and Windows inside the package. pnpm 9 still tries `node-gyp rebuild` unless the package is listed in `pnpm.neverBuiltDependencies` or scripts are skipped. |

## Login CLIs (2026-10-22, Claude Code 2.1.220, gh 2.91.0, Windows, stdin from /dev/null)

Checked before the Connections page was built. Linux (`script -qefc` fallback) still needs one manual check on a real server.

| Topic | Observed |
|---|---|
| `claude auth login --claudeai` over pipes | Works without a terminal. With `BROWSER=true` it prints `Opening browser to sign in…`, then `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...`, then the prompt `Paste code here if prompted > ` and waits for a line on stdin. |
| Claude login URL host | `claude.com` (redirect target `platform.claude.com`). |
| `claude auth status --json`, signed out | Keys: `loggedIn` (false), `authMethod` (`none`), `apiProvider`. Signed-in keys were not recorded; the adapter reads `loggedIn`, `authMethod` and `subscriptionType` only and never the email. |
| `gh auth login --web --git-protocol https --skip-ssh-key` over pipes | Works. Prints `! First copy your one-time code: XXXX-XXXX` and `Open this URL to continue in your web browser: https://github.com/login/device`, then polls. |
| `gh auth status` | Prints `Logged in to github.com account <login> (keyring)` when signed in. The adapter reads the login from that line only. |
