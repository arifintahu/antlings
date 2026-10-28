import { afterEach, describe, expect, it } from 'vitest';
import type { StoredEvent, UiEvent } from '@antlings/shared';
import { IDLE_CLOSE_MS, LimitError } from './sessions.js';
import { makeKit, type Kit } from './testkit.js';

let kit: Kit;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

const NEW = { cwd: '/home/u/proj', model: 'sonnet', mode: 'default' as const };
const kinds = (evs: StoredEvent[]) => evs.map((e) => e.event.k);
const until = async (pred: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const find = (id: string, k: UiEvent['k']) => kit.mgr.eventsAfter(id, 0).find((e) => e.event.k === k)?.event;

describe('streaming a turn', () => {
  it('logs user text, assistant text, state, turn_done, context and plan usage in order', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'hello');
    await until(() => kinds(kit.mgr.eventsAfter(id, 0)).includes('plan_usage'));
    const evs = kit.mgr.eventsAfter(id, 0);
    expect(kinds(evs)).toEqual([
      'settings', // from create
      'user',
      'state', // thinking
      'settings', // system:init, sent every turn
      'assistant_text',
      'turn_done',
      'state', // done
      'context',
      'plan_usage',
    ]);
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(find(id, 'context')).toMatchObject({ percentage: 12, totalTokens: 24_000 });
    expect(find(id, 'plan_usage')).toMatchObject({ usage: { status: 'ok', fiveHour: { percent: 31 } } });
  });

  it('a second turn reuses the process and the init message does not start a new session', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'hello');
    await until(() => kinds(kit.mgr.eventsAfter(id, 0)).filter((k) => k === 'turn_done').length === 1);
    await kit.mgr.send(id, 'hello');
    await until(() => kinds(kit.mgr.eventsAfter(id, 0)).filter((k) => k === 'turn_done').length === 2);
    expect(kit.agents.handles).toHaveLength(1);
    expect(kit.agents.last.opts.resume).toBe(false);
  });

  it('passes the permission mode, model and the session id to the agent', async () => {
    kit = await makeKit();
    const m = await kit.mgr.create({ ...NEW, effort: 'low' });
    expect(kit.agents.last.opts).toMatchObject({
      sessionId: m.id,
      cwd: NEW.cwd,
      model: 'sonnet',
      mode: 'default',
      effort: 'low',
    });
  });
});

describe('approvals', () => {
  it('an approval request reaches the log and Approve lets the tool run', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'tool');
    await until(() => !!find(id, 'approval_request'));
    const req = find(id, 'approval_request') as Extract<UiEvent, { k: 'approval_request' }>;
    expect(req).toMatchObject({ toolName: 'Bash', input: { command: 'ls' } });
    expect(kit.mgr.pendingApprovals(id)).toBe(1);
    expect(kit.mgr.approve(id, req.requestId)).toBe(true);
    await until(() => !!find(id, 'turn_done'));
    expect(find(id, 'approval_resolved')).toMatchObject({ decision: 'allow' });
    const res = kit.mgr.eventsAfter(id, 0).find((e) => e.event.k === 'tool_result')!.event;
    expect(res).toMatchObject({ ok: true, text: 'a.txt' });
  });

  it('Deny reaches the agent as a denial', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'tool');
    await until(() => !!find(id, 'approval_request'));
    const req = find(id, 'approval_request') as Extract<UiEvent, { k: 'approval_request' }>;
    expect(kit.mgr.deny(id, req.requestId, 'no')).toBe(true);
    await until(() => !!find(id, 'turn_done'));
    expect(find(id, 'approval_resolved')).toMatchObject({ decision: 'deny' });
    expect(kit.mgr.eventsAfter(id, 0).find((e) => e.event.k === 'tool_result')!.event).toMatchObject({
      ok: false,
    });
  });

  it('a stale or unknown request id is refused and an answered request cannot be answered twice', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'tool');
    await until(() => !!find(id, 'approval_request'));
    const req = find(id, 'approval_request') as Extract<UiEvent, { k: 'approval_request' }>;
    expect(kit.mgr.approve(id, 'nope')).toBe(false);
    expect(kit.mgr.approve(id, req.requestId)).toBe(true);
    expect(kit.mgr.deny(id, req.requestId)).toBe(false);
  });

  it('interrupt denies waiting requests and stops the turn', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'tool');
    await until(() => !!find(id, 'approval_request'));
    await kit.mgr.interrupt(id);
    expect(kit.agents.last.calls).toContain('interrupt');
    expect(kit.mgr.pendingApprovals(id)).toBe(0);
  });

  it('records approvals in the audit log', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'tool');
    await until(() => !!find(id, 'approval_request'));
    kit.mgr.approve(id, (find(id, 'approval_request') as { requestId: string }).requestId);
    expect(kit.auth.recentAudit().some((r) => r.kind === 'approval')).toBe(true);
  });
});

describe('interrupt and stopTask', () => {
  it('interrupt ends a running turn', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'slow');
    await until(() => !!find(id, 'assistant_text'));
    await kit.mgr.interrupt(id);
    await until(() => !!find(id, 'turn_done'));
  });

  it('stopTask stops one subagent and the ant ends as stopped', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'slow-agent');
    await until(() => !!find(id, 'task_started'));
    await kit.mgr.stopTask(id, 't2');
    await until(() => !!find(id, 'task_done'));
    expect(kit.agents.last.calls).toContain('stopTask:t2');
    expect(find(id, 'task_done')).toMatchObject({ taskId: 't2', status: 'stopped' });
  });
});

describe('subagent lifecycle', () => {
  it('maps task events and keeps subagent messages tied to their parent tool call', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'agent');
    await until(() => !!find(id, 'turn_done'));
    const evs = kit.mgr.eventsAfter(id, 0).map((e) => e.event);
    const started = evs.filter((e) => e.k === 'task_started');
    expect(started).toHaveLength(1); // the background shell is not an ant
    expect(started[0]).toMatchObject({
      taskId: 't1',
      toolUseId: 'tu-agent',
      subagentType: 'Explore',
      description: 'look around',
    });
    expect(evs.find((e) => e.k === 'task_progress')).toMatchObject({
      taskId: 't1',
      lastTool: 'Read',
      usage: { totalTokens: 500 },
    });
    expect(evs.find((e) => e.k === 'task_done')).toMatchObject({
      taskId: 't1',
      status: 'completed',
      report: 'Found 3 files',
      usage: { totalTokens: 900, toolUses: 2, durationMs: 2000 },
    });
    const sub = evs.find((e) => e.k === 'tool_use' && e.name === 'Read');
    expect(sub).toMatchObject({ parentToolUseId: 'tu-agent' });
    expect(evs.find((e) => e.k === 'tool_use' && e.name === 'Agent')).toBeTruthy();
    // only top-level tool calls change the lead's state
    expect(
      evs.filter((e) => e.k === 'state' && e.state === 'tool').map((e) => (e as { tool?: string }).tool),
    ).toEqual(['Agent']);
  });

  it('passes through the SDK concurrency limit message', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'limit');
    await until(() => !!find(id, 'task_done'));
    expect(find(id, 'task_done')).toMatchObject({
      status: 'failed',
      report: 'Concurrent subagent limit reached',
    });
  });
});

describe('limits', () => {
  it('refuses a third running session with a clear message', async () => {
    kit = await makeKit();
    await kit.mgr.create(NEW);
    await kit.mgr.create(NEW);
    await expect(kit.mgr.create(NEW)).rejects.toThrow(LimitError);
    await expect(kit.mgr.create(NEW)).rejects.toThrow(/Only 2 sessions/);
  });

  it('a closed session frees its slot and resumes from the transcript on the next message', async () => {
    kit = await makeKit();
    const a = await kit.mgr.create(NEW);
    await kit.mgr.create(NEW);
    kit.mgr.close(a.id);
    await until(() => !kit.mgr.isRunning(a.id));
    await kit.mgr.create(NEW);
    await expect(kit.mgr.send(a.id, 'hello')).rejects.toThrow(LimitError);
  });

  it('reaps idle sessions only when nothing is running or waiting', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'tool');
    await until(() => !!find(id, 'approval_request'));
    kit.clock.advance(IDLE_CLOSE_MS + 1);
    expect(kit.mgr.reapIdle()).toEqual([]); // waiting for an approval
    kit.mgr.approve(id, (find(id, 'approval_request') as { requestId: string }).requestId);
    await until(() => !!find(id, 'turn_done'));
    kit.clock.advance(IDLE_CLOSE_MS + 1);
    expect(kit.mgr.reapIdle()).toEqual([id]);
    await until(() => !kit.mgr.isRunning(id));
  });
});

describe('concurrent starts', () => {
  it('three parallel creates start two sessions and refuse the third', async () => {
    kit = await makeKit();
    const r = await Promise.allSettled([kit.mgr.create(NEW), kit.mgr.create(NEW), kit.mgr.create(NEW)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
  });

  it('two messages sent at once to a closed session both go through after one resume', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    kit.mgr.close(id);
    await until(() => !kit.mgr.isRunning(id));
    await Promise.all([kit.mgr.send(id, 'hello'), kit.mgr.send(id, 'hello')]);
    expect(kit.agents.handles).toHaveLength(2); // the original and one resumed process
    expect(kit.mgr.eventsAfter(id, 0).filter((e) => e.event.k === 'user')).toHaveLength(2);
  });
});

describe('resume', () => {
  it('resumes a closed session with resume=true and closes requests nobody can answer', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    kit.transcripts.add(id, { cwd: NEW.cwd }); // the real agent writes this with its first message
    await kit.mgr.send(id, 'tool');
    await until(() => !!find(id, 'approval_request'));
    kit.mgr.close(id); // the backend goes away with a request still open
    await until(() => !kit.mgr.isRunning(id));
    await kit.mgr.send(id, 'hello');
    expect(kit.agents.handles).toHaveLength(2);
    expect(kit.agents.last.opts).toMatchObject({ resume: true, sessionId: id, cwd: NEW.cwd });
    const resolved = kit.mgr.eventsAfter(id, 0).filter((e) => e.event.k === 'approval_resolved');
    expect(resolved).toHaveLength(1);
  });

  it('starts, not resumes, a session that was closed before its first message (it has no transcript)', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    kit.mgr.close(id);
    await until(() => !kit.mgr.isRunning(id));
    await kit.mgr.send(id, 'hello');
    expect(kit.agents.last.opts).toMatchObject({ resume: false, sessionId: id });
  });

  it('resumes a session started outside Antlings using the transcript folder', async () => {
    kit = await makeKit();
    kit.transcripts.add('ext-1', { cwd: '/home/u/other' });
    await kit.mgr.send('ext-1', 'hello');
    expect(kit.agents.last.opts).toMatchObject({ resume: true, cwd: '/home/u/other' });
    await expect(kit.mgr.send('missing', 'hello')).rejects.toThrow(/not found/i);
  });
});

describe('replay after reconnect', () => {
  it('delivers missed events once, in order, then live events', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'hello');
    await until(() => !!find(id, 'plan_usage'));
    const all = kit.mgr.eventsAfter(id, 0);
    const got: number[] = [];
    const off = kit.mgr.subscribe(id, 3, (m) => m.t === 'event' && got.push(m.seq));
    expect(got).toEqual(all.slice(3).map((e) => e.seq));
    await kit.mgr.send(id, 'hello');
    await until(() => got.length > all.length - 3 + 3);
    off();
    expect(new Set(got).size).toBe(got.length);
    expect(got).toEqual([...got].sort((a, b) => a - b));
    expect(got[0]).toBe(4);
  });

  it('replays a backlog larger than one page, with nothing missing', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    for (let i = 0; i < 4500; i++) kit.mgr.emit(id, { k: 'notice', message: `n${i}` });
    const got: number[] = [];
    const off = kit.mgr.subscribe(id, 0, (m) => m.t === 'event' && got.push(m.seq));
    off();
    expect(got).toHaveLength(4501);
    expect(got).toEqual(Array.from({ length: 4501 }, (_, i) => i + 1));
  });

  it('keeps the sequence going after a restart', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.send(id, 'hello');
    await until(() => !!find(id, 'plan_usage'));
    kit.mgr.close(id);
    await until(() => !kit.mgr.isRunning(id));
    await new Promise((r) => setTimeout(r, 20));
    const last = kit.mgr.eventsAfter(id, 0).at(-1)!.seq;
    const { SessionManager } = await import('./sessions.js');
    const second = new SessionManager({
      db: kit.auth.db,
      clock: kit.clock,
      config: kit.auth.config,
      agents: kit.agents,
      transcripts: kit.transcripts,
      uploads: kit.uploads,
      audit: () => undefined,
    });
    expect(second.emit(id, { k: 'notice', message: 'x' }).seq).toBe(last + 1);
  });
});

describe('settings changes', () => {
  it('sends model, mode and effort to the agent, stores them and logs a settings event', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    await kit.mgr.setModel(id, 'haiku');
    await kit.mgr.setPermissionMode(id, 'plan');
    await kit.mgr.setEffort(id, 'high');
    expect(kit.agents.last.calls).toEqual(['setModel:haiku', 'setPermissionMode:plan', 'setEffort:high']);
    expect(kit.mgr.meta(id)).toMatchObject({ model: 'haiku', mode: 'plan', effort: 'high' });
    expect(kit.auth.recentAudit().some((r) => r.kind === 'mode_changed')).toBe(true);
  });
});

describe('plan usage', () => {
  it('shows unavailable when the experimental call fails', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    kit.agents.last.plan = new Error('method removed');
    await kit.mgr.send(id, 'hello');
    await until(() => !!find(id, 'plan_usage'));
    expect(find(id, 'plan_usage')).toEqual({ k: 'plan_usage', usage: { status: 'unavailable' } });
  });

  it('shows unavailable with an API key (rate_limits_available false)', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    kit.agents.last.plan = { rate_limits_available: false, rate_limits: null };
    await kit.mgr.send(id, 'hello');
    await until(() => !!find(id, 'plan_usage'));
    expect(find(id, 'plan_usage')).toEqual({ k: 'plan_usage', usage: { status: 'unavailable' } });
  });

  it('converts the fraction in rate_limit_event to a percentage', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    kit.agents.last.plan = new Error('x');
    await kit.mgr.send(id, 'rate');
    await until(() => kit.mgr.eventsAfter(id, 0).filter((e) => e.event.k === 'plan_usage').length >= 2);
    const first = kit.mgr.eventsAfter(id, 0).find((e) => e.event.k === 'plan_usage')!.event;
    expect(first).toMatchObject({ usage: { status: 'ok', fiveHour: { percent: 50 } } });
  });
});

describe('models', () => {
  it('lists models from the SDK, cached for an hour', async () => {
    kit = await makeKit();
    expect((await kit.mgr.modelList()).map((m) => m.value)).toEqual(['sonnet', 'haiku']);
    await kit.mgr.modelList();
    expect(kit.agents.probeCalls).toBe(1);
  });
});

describe('delete', () => {
  it('removes transcript, log and metadata, and late events from the dying process are dropped', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    kit.transcripts.add(id);
    await kit.mgr.send(id, 'hello');
    await until(() => !!find(id, 'plan_usage'));
    await kit.mgr.remove(id);
    await new Promise((r) => setTimeout(r, 50));
    expect(kit.mgr.eventsAfter(id, 0)).toEqual([]);
    expect(kit.mgr.meta(id)).toBeUndefined();
    expect(await kit.transcripts.info(id)).toBeUndefined();
    expect(kit.auth.recentAudit().some((r) => r.kind === 'session_deleted')).toBe(true);
  });
});
