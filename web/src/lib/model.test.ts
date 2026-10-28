import type { UiEvent } from '@antlings/shared';
import { describe, expect, it } from 'vitest';
import { applyDelta, applyEvent, counts, newView, type SessionView } from './model.js';

const run = (events: UiEvent[], v: SessionView = newView('s')) => {
  events.forEach((e, i) => applyEvent(v, v.lastSeq + 1 + i * 0, 1000 + i, e));
  return v;
};
// helper that assigns sequential seqs
const feed = (v: SessionView, ...events: UiEvent[]) => {
  for (const e of events) applyEvent(v, v.lastSeq + 1, 1000, e);
  return v;
};

describe('applyEvent', () => {
  it('keeps the attachments of a user message', () => {
    const v = newView('s');
    const att = { id: 'u1', name: 'a.png', size: 10, kind: 'image' as const };
    applyEvent(v, 1, 0, { k: 'user', text: 'look', attachments: [att] });
    applyEvent(v, 2, 0, { k: 'user', text: 'plain' });
    expect(v.items[0]).toMatchObject({ kind: 'user', attachments: [att] });
    expect(v.items[1]).not.toHaveProperty('attachments');
  });

  it('ignores a seq it has already seen, so a replay cannot double messages', () => {
    const v = newView('s');
    expect(applyEvent(v, 1, 0, { k: 'user', text: 'hi' })).toBe(true);
    expect(applyEvent(v, 1, 0, { k: 'user', text: 'hi' })).toBe(false);
    expect(applyEvent(v, 0, 0, { k: 'user', text: 'old' })).toBe(false);
    expect(v.items).toHaveLength(1);
    expect(v.lastSeq).toBe(1);
  });

  it('builds the lead timeline: user, text, tool call with result', () => {
    const v = feed(
      newView('s'),
      { k: 'user', text: 'go' },
      { k: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'ls' } },
      { k: 'tool_result', toolUseId: 't1', ok: true, text: 'a.txt' },
      { k: 'assistant_text', text: 'done' },
      { k: 'turn_done', isError: false },
    );
    expect(v.items.map((i) => i.kind)).toEqual(['user', 'tool', 'agent']);
    expect(v.items[1]).toMatchObject({ name: 'Bash', result: { ok: true, text: 'a.txt' } });
    expect(v.turnRunning).toBe(false);
  });

  it('one ant per subagent: log, tokens, report, and the spawn row', () => {
    const v = feed(
      newView('s'),
      { k: 'tool_use', toolUseId: 'agent-call', name: 'Agent', input: {} },
      {
        k: 'task_started',
        taskId: 't1',
        toolUseId: 'agent-call',
        description: 'look',
        subagentType: 'Explore',
      },
      {
        k: 'tool_use',
        toolUseId: 'r1',
        name: 'Read',
        input: { file_path: 'a.ts' },
        parentToolUseId: 'agent-call',
      },
      {
        k: 'task_progress',
        taskId: 't1',
        lastTool: 'Read',
        usage: { totalTokens: 500, toolUses: 1, durationMs: 10 },
      },
      { k: 'tool_result', toolUseId: 'r1', ok: true, text: '', parentToolUseId: 'agent-call' },
      {
        k: 'task_done',
        taskId: 't1',
        status: 'completed',
        report: 'Found it',
        usage: { totalTokens: 900, toolUses: 2, durationMs: 20 },
      },
    );
    expect(v.items.map((i) => i.kind)).toEqual(['spawn']); // the Agent call itself is not a tool card
    const a = v.ants[0]!;
    expect(a).toMatchObject({
      subagentType: 'Explore',
      state: 'done',
      report: 'Found it',
      totalTokens: 900,
      toolUses: 2,
    });
    expect(a.log).toEqual([{ toolUseId: 'r1', name: 'Read', arg: 'a.ts', st: 'ok' }]);
    expect(counts(v.ants)).toEqual({ run: 0, wait: 0, done: 1, fail: 0 });
  });

  it('a subagent approval waits on its own ant and resolves back to running or not', () => {
    const v = feed(
      newView('s'),
      {
        k: 'task_started',
        taskId: 't1',
        toolUseId: 'ac',
        description: 'run tests',
        subagentType: 'test-runner',
      },
      {
        k: 'tool_use',
        toolUseId: 'b1',
        name: 'Bash',
        input: { command: 'pnpm test' },
        parentToolUseId: 'ac',
      },
      {
        k: 'approval_request',
        requestId: 'r',
        toolName: 'Bash',
        toolUseId: 'b1',
        input: { command: 'pnpm test' },
        parentToolUseId: 'ac',
      },
    );
    expect(v.ants[0]).toMatchObject({ state: 'approval', approval: { requestId: 'r', status: 'waiting' } });
    expect(v.ants[0]!.log[0]!.st).toBe('ask');
    expect(v.items.some((i) => i.kind === 'approval')).toBe(false);
    feed(v, { k: 'approval_resolved', requestId: 'r', decision: 'allow' });
    expect(v.ants[0]).toMatchObject({ state: 'tool', approval: { status: 'allowed' } });
    expect(v.ants[0]!.log[0]!.st).toBe('run');
  });

  it('a lead approval is a timeline card that changes status', () => {
    const v = feed(
      newView('s'),
      { k: 'approval_request', requestId: 'r', toolName: 'Bash', input: { command: 'rm x' } },
      { k: 'state', state: 'approval', tool: 'Bash' },
    );
    expect(v.items[0]).toMatchObject({ kind: 'approval', status: 'waiting' });
    expect(v.state).toBe('approval');
    feed(v, { k: 'approval_resolved', requestId: 'r', decision: 'deny' });
    expect(v.items[0]).toMatchObject({ status: 'denied' });
  });

  it('stopped and failed subagents end as idle and error; a failure adds a notice', () => {
    const v = feed(
      newView('s'),
      { k: 'task_started', taskId: 'a', description: 'x', subagentType: 'g' },
      { k: 'task_started', taskId: 'b', description: 'y', subagentType: 'g' },
      { k: 'task_done', taskId: 'a', status: 'stopped' },
      { k: 'task_done', taskId: 'b', status: 'failed', report: 'Concurrent subagent limit reached' },
    );
    expect(v.ants.map((a) => a.state)).toEqual(['idle', 'error']);
    expect(v.items.at(-1)).toMatchObject({
      kind: 'notice',
      bad: true,
      text: 'Concurrent subagent limit reached',
    });
  });

  it('tracks lead state, settings, context and errors', () => {
    const v = run([
      { k: 'settings', model: 'sonnet', mode: 'plan', effort: 'low' },
      { k: 'state', state: 'tool', tool: 'Read' },
      { k: 'context', percentage: 12, totalTokens: 24000, maxTokens: 200000 },
      { k: 'error', message: 'boom' },
    ]);
    expect(v).toMatchObject({
      model: 'sonnet',
      mode: 'plan',
      effort: 'low',
      state: 'error',
      context: { percentage: 12 },
    });
    expect(v.items.at(-1)).toMatchObject({ kind: 'notice', bad: true });
  });

  it('puts the approval inside the tool card of the same call (one card, not two)', () => {
    const v = feed(
      newView('s'),
      { k: 'tool_use', toolUseId: 'w1', name: 'Write', input: { file_path: 'a' } },
      {
        k: 'approval_request',
        requestId: 'r1',
        toolName: 'Write',
        toolUseId: 'w1',
        input: { file_path: 'a' },
      },
    );
    expect(v.items.map((i) => i.kind)).toEqual(['tool']);
    expect(v.items[0]).toMatchObject({ approval: { requestId: 'r1', status: 'waiting' } });
    feed(
      v,
      { k: 'approval_resolved', requestId: 'r1', decision: 'allow' },
      { k: 'tool_result', toolUseId: 'w1', ok: true, text: 'done' },
    );
    expect(v.items[0]).toMatchObject({ approval: { status: 'allowed' }, result: { ok: true } });
  });

  it('streams text live and replaces it with the final message', () => {
    const v = newView('s');
    applyDelta(v, 'Hel');
    applyDelta(v, 'lo');
    expect(v.streaming).toBe('Hello');
    feed(v, { k: 'assistant_text', text: 'Hello world' });
    expect(v.streaming).toBe('');
    expect(v.items.at(-1)).toMatchObject({ kind: 'agent', text: 'Hello world' });
    applyDelta(v, 'x');
    feed(v, { k: 'turn_done', isError: false });
    expect(v.streaming).toBe('');
  });

  it('adds up the cost of each turn', () => {
    const v = feed(
      newView('s'),
      { k: 'turn_done', costUsd: 0.01, isError: false },
      { k: 'turn_done', costUsd: 0.025, isError: false },
      { k: 'turn_done', isError: false },
    );
    expect(v.costUsd).toBeCloseTo(0.035);
  });
});
