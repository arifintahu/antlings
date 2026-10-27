import type {
  CanUseTool,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@antlings/shared';
import type { Config } from './config.js';
import type { ClaudeMode } from './connections/store.js';

export type { ModelInfo, SDKMessage };

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StartOptions {
  sessionId: string;
  /** True when the SDK should load an existing transcript instead of creating the session. */
  resume: boolean;
  cwd: string;
  model: string;
  effort?: Effort;
  mode: PermissionMode;
  canUseTool: CanUseTool;
  /** Hard spend cap for the process. Set by live tests. */
  maxBudgetUsd?: number;
}

export interface ContextUsage {
  percentage: number;
  totalTokens: number;
  maxTokens: number;
}

/** Raw reply of the SDK's experimental usage call. Only the fields Antlings reads. */
export interface RawPlanUsage {
  rate_limits_available: boolean;
  rate_limits: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null;
    seven_day?: { utilization: number | null; resets_at: string | null } | null;
  } | null;
}

/** One running Claude Code session. The real implementation wraps the SDK; tests use a fake. */
export interface AgentHandle {
  messages: AsyncIterable<SDKMessage>;
  send(text: string): void;
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setEffort(level: Effort): Promise<void>;
  contextUsage(): Promise<ContextUsage>;
  planUsage(): Promise<RawPlanUsage>;
  supportedModels(): Promise<ModelInfo[]>;
  close(): void;
}

export interface AgentFactory {
  /** Loads the SDK on first use. It is a large module, so the idle service does not pay for it. */
  load?(): Promise<void>;
  start(o: StartOptions): AgentHandle;
  /** Lists models without a user session. May start and stop a short-lived process. */
  probeModels(): Promise<ModelInfo[]>;
}

/** Async queue feeding user turns into a streaming `query()`. */
class Inbox {
  private items: (SDKUserMessage | null)[] = [];
  private wake: (() => void) | undefined;

  push(m: SDKUserMessage | null): void {
    this.items.push(m);
    this.wake?.();
  }

  async *iterate(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.items.length === 0) await new Promise<void>((r) => (this.wake = r));
      const next = this.items.shift();
      if (next === null || next === undefined) return;
      yield next;
    }
  }
}

/** The agent's shell gets a small allowlist, never the service's own secrets (ANTLINGS_*). */
export const ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'SHELL',
  'XDG_CONFIG_HOME',
  'NODE_EXTRA_CA_CERTS',
];

/** The Claude sign-in choice stored through the Connections page. It wins over the env file. */
export interface ClaudeAuthSource {
  mode: ClaudeMode;
  apiKey?: string;
}

export function sdkEnv(
  config: Config,
  source: NodeJS.ProcessEnv = process.env,
  stored?: ClaudeAuthSource,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const k of ENV_ALLOW) env[k] = source[k];
  for (const [k, v] of Object.entries(source)) if (/^(CLAUDE_|HTTPS?_PROXY$|NO_PROXY$)/i.test(k)) env[k] = v;
  if ((stored?.mode ?? config.authMode) === 'apikey')
    env.ANTHROPIC_API_KEY = stored?.apiKey ?? source.ANTHROPIC_API_KEY;
  env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(config.maxSubagents);
  return env;
}

export function sdkAgentFactory(config: Config, authSource?: () => ClaudeAuthSource): AgentFactory {
  let sdk: typeof import('@anthropic-ai/claude-agent-sdk') | undefined;
  const query = (p: Parameters<NonNullable<typeof sdk>['query']>[0]) => {
    if (!sdk) throw new Error('SDK not loaded');
    return sdk.query(p);
  };
  const baseOptions = (): Options => ({
    ...(config.claudePath ? { pathToClaudeCodeExecutable: config.claudePath } : {}),
    settingSources: ['project'],
    env: sdkEnv(config, process.env, authSource?.()),
    includePartialMessages: true,
  });

  return {
    async load() {
      sdk ??= await import('@anthropic-ai/claude-agent-sdk');
    },

    start(o) {
      const inbox = new Inbox();
      const abort = new AbortController();
      const q = query({
        prompt: inbox.iterate(),
        options: {
          ...baseOptions(),
          cwd: o.cwd,
          model: o.model,
          ...(o.effort ? { effort: o.effort } : {}),
          permissionMode: o.mode,
          ...(o.mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
          ...(o.resume ? { resume: o.sessionId } : { sessionId: o.sessionId }),
          canUseTool: o.canUseTool,
          ...(o.maxBudgetUsd ? { maxBudgetUsd: o.maxBudgetUsd } : {}),
          abortController: abort,
        },
      });
      return {
        messages: q,
        send(text) {
          inbox.push({
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
          });
        },
        interrupt: async () => void (await q.interrupt()),
        stopTask: (id) => q.stopTask(id),
        setModel: (m) => q.setModel(m),
        setPermissionMode: (m) => q.setPermissionMode(m),
        setEffort: (level) => q.applyFlagSettings({ effortLevel: level }),
        async contextUsage() {
          const u = await q.getContextUsage({ detail: 'summary' });
          return { percentage: u.percentage, totalTokens: u.totalTokens, maxTokens: u.maxTokens };
        },
        planUsage: () =>
          q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
            skipBehaviors: true,
          }) as Promise<RawPlanUsage>,
        supportedModels: () => q.supportedModels(),
        close() {
          inbox.push(null);
          abort.abort();
          q.close();
        },
      };
    },

    async probeModels() {
      sdk ??= await import('@anthropic-ai/claude-agent-sdk');
      const inbox = new Inbox();
      const q = query({
        prompt: inbox.iterate(),
        options: { ...baseOptions(), cwd: config.home, persistSession: false },
      });
      try {
        return await q.supportedModels();
      } finally {
        inbox.push(null);
        q.close();
      }
    },
  };
}
