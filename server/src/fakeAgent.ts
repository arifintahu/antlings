import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@antlings/shared';
import type {
  AgentFactory,
  AgentHandle,
  ContextUsage,
  Effort,
  ModelInfo,
  RawPlanUsage,
  SDKMessage,
  StartOptions,
} from './agent.js';
import type { Transcripts, TranscriptInfo, TranscriptMessage } from './transcripts.js';

/**
 * Test double for the Agent SDK. It emits message objects shaped like the ones recorded in
 * docs/sdk-notes.md. The cast to SDKMessage is deliberate: the fake only fills the fields Antlings reads.
 */
const asMsg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage;

export interface Api {
  emit(m: Record<string, unknown>): void;
  ask(toolName: string, input: Record<string, unknown>): Promise<PermissionResult>;
  /** Resolves when the turn is interrupted or the task is stopped. */
  untilStopped(taskId?: string): Promise<'interrupt' | 'stop'>;
}

export type Scenario = (text: string, api: Api, h: FakeHandle) => Promise<void>;

let uuidN = 0;
const uid = () => `u-${++uuidN}`;

export class FakeHandle implements AgentHandle {
  calls: string[] = [];
  closed = false;
  context: ContextUsage = { percentage: 12, totalTokens: 24_000, maxTokens: 200_000 };
  plan: RawPlanUsage | Error = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 31, resets_at: '2026-10-12T15:00:00Z' },
      seven_day: { utilization: 8, resets_at: null },
    },
  };
  private queue: SDKMessage[] = [];
  private wake: (() => void) | undefined;
  private stopWaiters = new Map<string | undefined, (r: 'interrupt' | 'stop') => void>();
  turns = 0;

  constructor(
    readonly opts: StartOptions,
    private scenario: Scenario,
  ) {}

  private push(m: SDKMessage | null): void {
    if (m) this.queue.push(m);
    else this.closed = true;
    this.wake?.();
  }

  messages: AsyncIterable<SDKMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        for (;;) {
          const m = this.queue.shift();
          if (m) return { value: m, done: false };
          if (this.closed) return { value: undefined, done: true };
          await new Promise<void>((r) => (this.wake = r));
        }
      },
    }),
  };

  private api: Api = {
    emit: (m) => this.push(asMsg({ uuid: uid(), session_id: this.opts.sessionId, ...m })),
    ask: async (toolName, input) =>
      (await this.opts.canUseTool(toolName, input, {
        signal: new AbortController().signal,
        toolUseID: uid(),
      } as never)) ?? {
        behavior: 'deny',
        message: 'no decision',
      },
    untilStopped: (taskId) =>
      new Promise((resolve) => {
        this.stopWaiters.set(taskId, resolve);
      }),
  };

  send(text: string): void {
    this.calls.push(`send:${text}`);
    this.turns += 1;
    void (async () => {
      this.api.emit({
        type: 'system',
        subtype: 'init',
        model: this.opts.model,
        permissionMode: this.opts.mode,
        cwd: this.opts.cwd,
        tools: [],
      });
      try {
        await this.scenario(text, this.api, this);
      } catch (e) {
        this.api.emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          total_cost_usd: 0,
          errors: [String(e)],
        });
      }
    })();
  }

  async interrupt(): Promise<void> {
    this.calls.push('interrupt');
    this.stopWaiters.get(undefined)?.('interrupt');
  }
  async stopTask(taskId: string): Promise<void> {
    this.calls.push(`stopTask:${taskId}`);
    this.stopWaiters.get(taskId)?.('stop');
  }
  async setModel(model: string): Promise<void> {
    this.calls.push(`setModel:${model}`);
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.calls.push(`setPermissionMode:${mode}`);
  }
  async setEffort(level: Effort): Promise<void> {
    this.calls.push(`setEffort:${level}`);
  }
  async contextUsage(): Promise<ContextUsage> {
    return this.context;
  }
  async planUsage(): Promise<RawPlanUsage> {
    if (this.plan instanceof Error) throw this.plan;
    return this.plan;
  }
  async supportedModels(): Promise<ModelInfo[]> {
    return MODELS;
  }
  close(): void {
    this.calls.push('close');
    this.push(null);
  }
}

export const MODELS: ModelInfo[] = [
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false },
];

/** Default scenarios keyed by the text the test sends. */
export const defaultScenario: Scenario = async (text, api) => {
  const result = () =>
    api.emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: 'ok' });
  const say = (t: string, parent: string | null = null) =>
    api.emit({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'text', text: t }] },
    });

  if (text === 'hello') {
    say('Hi there');
    return result();
  }
  if (text === 'tool') {
    api.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } }] },
    });
    const r = await api.ask('Bash', { command: 'ls' });
    api.emit({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            is_error: r.behavior === 'deny',
            content: r.behavior === 'allow' ? 'a.txt' : 'denied',
          },
        ],
      },
    });
    say(r.behavior === 'allow' ? 'Listed' : 'Not allowed');
    return result();
  }
  if (text === 'agent') {
    api.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu-agent',
            name: 'Agent',
            input: { description: 'look around', prompt: 'p' },
          },
        ],
      },
    });
    api.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 't1',
      tool_use_id: 'tu-agent',
      description: 'look around',
      subagent_type: 'Explore',
      task_type: 'local_agent',
    });
    api.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bg1',
      description: 'background shell',
      task_type: 'local_bash',
    });
    api.emit({
      type: 'assistant',
      parent_tool_use_id: 'tu-agent',
      message: { content: [{ type: 'tool_use', id: 'tu-sub', name: 'Read', input: { file_path: 'a' } }] },
    });
    api.emit({
      type: 'system',
      subtype: 'task_progress',
      task_id: 't1',
      description: 'look around',
      last_tool_name: 'Read',
      usage: { total_tokens: 500, tool_uses: 1, duration_ms: 900 },
    });
    api.emit({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } });
    api.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      summary: 'Found 3 files',
      output_file: '',
      usage: { total_tokens: 900, tool_uses: 2, duration_ms: 2000 },
    });
    api.emit({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-agent',
            content: [{ type: 'text', text: 'Found 3 files' }],
          },
        ],
      },
    });
    say('Done');
    return result();
  }
  if (text === 'slow-agent') {
    api.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 't2',
      description: 'long job',
      subagent_type: 'general-purpose',
      task_type: 'local_agent',
    });
    await api.untilStopped('t2');
    api.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 't2',
      status: 'stopped',
      summary: 'Stopped',
      output_file: '',
    });
    return result();
  }
  if (text === 'slow') {
    say('working');
    await api.untilStopped();
    return result();
  }
  if (text === 'limit') {
    api.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 't3',
      status: 'failed',
      summary: 'Concurrent subagent limit reached',
      output_file: '',
    });
    return result();
  }
  if (text === 'stream') {
    for (const piece of ['Hel', 'lo ', 'world']) {
      api.emit({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } },
      });
    }
    api.emit({
      type: 'stream_event',
      parent_tool_use_id: 'sub-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SUBAGENT' } },
    });
    say('Hello world');
    return result();
  }
  if (text === 'rate') {
    api.emit({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.5,
        resetsAt: 1_800_003_600,
      },
    });
    return result();
  }
  say(`echo ${text}`);
  return result();
};

export class FakeAgents implements AgentFactory {
  handles: FakeHandle[] = [];
  probeCalls = 0;
  constructor(private scenario: Scenario = defaultScenario) {}
  start(o: StartOptions): FakeHandle {
    const h = new FakeHandle(o, this.scenario);
    this.handles.push(h);
    return h;
  }
  async probeModels(): Promise<ModelInfo[]> {
    this.probeCalls += 1;
    return MODELS;
  }
  get last(): FakeHandle {
    return this.handles.at(-1)!;
  }
}

/** In-memory transcripts for tests. */
export class FakeTranscripts implements Transcripts {
  items = new Map<
    string,
    TranscriptInfo & { messages: TranscriptMessage[]; subs: Record<string, TranscriptMessage[]> }
  >();
  add(id: string, over: Partial<TranscriptInfo> = {}, messages: TranscriptMessage[] = []): void {
    this.items.set(id, {
      sessionId: id,
      summary: 'x',
      lastModified: 1,
      cwd: '/home/u/proj',
      ...over,
      messages,
      subs: {},
    });
  }
  async list() {
    return [...this.items.values()].map(({ messages: _m, subs: _s, ...i }) => i);
  }
  async info(id: string) {
    const i = this.items.get(id);
    if (!i) return undefined;
    const { messages: _m, subs: _s, ...rest } = i;
    return rest;
  }
  async messages(id: string) {
    return this.items.get(id)?.messages ?? [];
  }
  async subagents(id: string) {
    return Object.keys(this.items.get(id)?.subs ?? {});
  }
  async subagentMessages(id: string, agentId: string) {
    return this.items.get(id)?.subs[agentId] ?? [];
  }
  async rename(id: string, title: string) {
    const i = this.items.get(id);
    if (i) i.customTitle = title;
  }
  async tag(id: string, tag: string | null) {
    const i = this.items.get(id);
    if (i) i.tag = tag ?? undefined;
  }
  async remove(id: string) {
    this.items.delete(id);
  }
}
