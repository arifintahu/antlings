import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeKit, type Creds, type Kit } from './testkit.js';

let kit: Kit;
let creds: Creds;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

async function setup() {
  kit = await makeKit();
  creds = await kit.signIn();
}
const get = (url: string) => kit.call({ method: 'GET', url, ...creds });
const post = (url: string, payload: unknown) =>
  kit.call({ method: 'POST', url, payload: payload as object, ...creds });
const patch = (url: string, payload: unknown) =>
  kit.call({ method: 'PATCH', url, payload: payload as object, ...creds });
const del = (url: string) => kit.call({ method: 'DELETE', url, ...creds });
const NEW = { folder: 'proj', model: 'sonnet', mode: 'default' };

describe('folders API', () => {
  it('lists, creates, and refuses traversal', async () => {
    await setup();
    expect((await get('/api/folders')).json().entries.map((e: { name: string }) => e.name)).toEqual(['proj']);
    expect((await post('/api/folders', { parent: '', name: 'new one' })).json()).toEqual({ path: 'new one' });
    expect((await get('/api/folders?path=..')).statusCode).toBe(400);
    expect((await get('/api/folders?path=%2e%2e%2f%2e%2e')).statusCode).toBe(400);
    expect((await get('/api/folders?path=missing')).statusCode).toBe(404);
    expect((await post('/api/folders', { parent: '', name: '../x' })).statusCode).toBe(400);
    expect((await post('/api/folders', { parent: '', name: 'proj' })).statusCode).toBe(409);
  });
});

describe('creating sessions', () => {
  it('starts a session in a folder inside home', async () => {
    await setup();
    const r = await post('/api/sessions', NEW);
    expect(r.statusCode).toBe(200);
    expect(kit.mgr.meta(r.json().id)).toMatchObject({
      cwd: join(kit.home, 'proj'),
      model: 'sonnet',
      mode: 'default',
    });
  });

  it('validates folder, model, effort and mode from the server lists', async () => {
    await setup();
    expect((await post('/api/sessions', { ...NEW, folder: '../..' })).statusCode).toBe(400);
    expect((await post('/api/sessions', { ...NEW, folder: 'nope' })).statusCode).toBe(404);
    expect((await post('/api/sessions', { ...NEW, model: 'gpt-9' })).json().error).toBe('bad_model');
    expect((await post('/api/sessions', { ...NEW, effort: 'max' })).json().error).toBe('bad_effort');
    expect((await post('/api/sessions', { ...NEW, model: 'haiku', effort: 'low' })).json().error).toBe(
      'bad_effort',
    );
    expect((await post('/api/sessions', { ...NEW, effort: 'high' })).statusCode).toBe(200);
    expect((await post('/api/sessions', { ...NEW, mode: 'root' })).statusCode).toBe(400);
    expect((await post('/api/sessions', { ...NEW, mode: 'dontAsk' })).statusCode).toBe(400);
  });

  it('Bypass mode needs a fresh step-up', async () => {
    await setup();
    const r = await post('/api/sessions', { ...NEW, mode: 'bypassPermissions' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('stepup_required');
    expect(kit.agents.handles).toHaveLength(0);
    await kit.stepUp(creds);
    expect((await post('/api/sessions', { ...NEW, mode: 'bypassPermissions' })).statusCode).toBe(200);
    expect(kit.agents.last.opts.mode).toBe('bypassPermissions');
  });

  it('a session in the home folder itself needs a fresh step-up', async () => {
    await setup();
    expect((await post('/api/sessions', { ...NEW, folder: '' })).json().error).toBe('stepup_required');
    await kit.stepUp(creds);
    expect((await post('/api/sessions', { ...NEW, folder: '' })).statusCode).toBe(200);
  });

  it('refuses a third running session with 409 and a message', async () => {
    await setup();
    await post('/api/sessions', NEW);
    await post('/api/sessions', NEW);
    const r = await post('/api/sessions', NEW);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      error: 'session_limit',
      message: expect.stringContaining('Only 2 sessions'),
    });
  });
});

describe('listing, renaming, archiving', () => {
  it('lists active and archived sessions inside home only', async () => {
    await setup();
    kit.transcripts.add(ID1, { cwd: join(kit.home, 'proj'), summary: 'Fix the bug', lastModified: 5 });
    kit.transcripts.add(ID2, {
      cwd: join(kit.home, 'proj'),
      summary: 'Old',
      lastModified: 9,
      tag: 'archived',
    });
    kit.transcripts.add('33333333-3333-4333-8333-333333333333', { cwd: '/etc', summary: 'Elsewhere' });
    const active = (await get('/api/sessions')).json().sessions;
    expect(active.map((s: { id: string }) => s.id)).toEqual([ID1]);
    expect(active[0]).toMatchObject({ title: 'Fix the bug', cwd: 'proj', archived: false, running: false });
    const arch = (await get('/api/sessions?archived=1')).json().sessions;
    expect(arch.map((s: { id: string }) => s.id)).toEqual([ID2]);
  });

  it('lists a session that has no message yet', async () => {
    await setup();
    const { id } = (await post('/api/sessions', NEW)).json();
    const active = (await get('/api/sessions')).json().sessions;
    expect(active.map((s: { id: string }) => s.id)).toContain(id);
    expect(active.find((s: { id: string }) => s.id === id)).toMatchObject({
      title: 'New session',
      cwd: 'proj',
      running: true,
    });
  });

  it('renames, archives and unarchives, and archiving closes the process', async () => {
    await setup();
    const { id } = (await post('/api/sessions', NEW)).json();
    kit.transcripts.add(id, { cwd: join(kit.home, 'proj') });
    expect((await patch(`/api/sessions/${id}`, { title: 'Nicer name' })).statusCode).toBe(200);
    expect(kit.transcripts.items.get(id)?.customTitle).toBe('Nicer name');
    expect((await patch(`/api/sessions/${id}`, { archived: true })).statusCode).toBe(200);
    expect(kit.transcripts.items.get(id)?.tag).toBe('archived');
    expect(kit.agents.last.calls).toContain('close');
    expect((await patch(`/api/sessions/${id}`, { archived: false })).statusCode).toBe(200);
    expect(kit.transcripts.items.get(id)?.tag).toBeUndefined();
    expect((await patch(`/api/sessions/${id}`, { title: '' })).statusCode).toBe(400);
  });

  it('refuses ids that are not UUIDs and sessions outside home', async () => {
    await setup();
    for (const id of ['x', '..%2f..%2fetc', 'a'.repeat(36)]) {
      expect((await get(`/api/sessions/${id}`)).statusCode, id).toBe(404);
      expect((await patch(`/api/sessions/${id}`, { archived: true })).statusCode, id).toBe(404);
    }
    kit.transcripts.add(ID1, { cwd: '/etc' });
    expect((await get(`/api/sessions/${ID1}`)).statusCode).toBe(404);
    expect((await patch(`/api/sessions/${ID1}`, { archived: true })).statusCode).toBe(404);
  });
});

describe('deleting', () => {
  it('needs a fresh step-up, then removes transcript and log', async () => {
    await setup();
    const { id } = (await post('/api/sessions', NEW)).json();
    kit.transcripts.add(id, { cwd: join(kit.home, 'proj') });
    const no = await del(`/api/sessions/${id}`);
    expect(no.statusCode).toBe(403);
    expect(no.json().error).toBe('stepup_required');
    expect(kit.transcripts.items.has(id)).toBe(true);
    await kit.stepUp(creds);
    expect((await del(`/api/sessions/${id}`)).statusCode).toBe(200);
    expect(kit.transcripts.items.has(id)).toBe(false);
    expect(kit.mgr.meta(id)).toBeUndefined();
    expect(kit.auth.recentAudit().some((r) => r.kind === 'session_deleted')).toBe(true);
  });

  it('a bad id is refused even with a fresh step-up', async () => {
    await setup();
    await kit.stepUp(creds);
    expect((await del('/api/sessions/not-a-uuid')).statusCode).toBe(404);
    kit.transcripts.add(ID1, { cwd: '/etc' });
    expect((await del(`/api/sessions/${ID1}`)).statusCode).toBe(404);
    expect(kit.transcripts.items.has(ID1)).toBe(true);
  });

  it('freshness runs out after five minutes', async () => {
    await setup();
    const { id } = (await post('/api/sessions', NEW)).json();
    await kit.stepUp(creds);
    kit.clock.advance(5 * 60_000 + 1);
    expect((await del(`/api/sessions/${id}`)).statusCode).toBe(403);
  });
});

describe('history and subagents', () => {
  it('builds history from the transcript for a session started in the terminal', async () => {
    await setup();
    kit.transcripts.add(ID1, { cwd: join(kit.home, 'proj') }, [
      { type: 'user', uuid: 'a', parent_tool_use_id: null, message: { content: 'Fix it' } },
      {
        type: 'assistant',
        uuid: 'b',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'On it' }] },
      },
    ]);
    expect((await get(`/api/sessions/${ID1}`)).statusCode).toBe(200);
    const kinds = kit.mgr.eventsAfter(ID1, 0).map((e) => e.event);
    expect(kinds).toEqual([
      { k: 'user', text: 'Fix it' },
      { k: 'assistant_text', text: 'On it' },
    ]);
    await get(`/api/sessions/${ID1}`); // idempotent
    expect(kit.mgr.eventsAfter(ID1, 0)).toHaveLength(2);
  });

  it('lists subagents and returns their messages as events', async () => {
    await setup();
    kit.transcripts.add(ID1, { cwd: join(kit.home, 'proj') });
    kit.transcripts.items.get(ID1)!.subs['agent-1'] = [
      {
        type: 'assistant',
        uuid: 'x',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Found it' }] },
      },
    ];
    expect((await get(`/api/sessions/${ID1}/subagents`)).json().agents).toEqual([{ agentId: 'agent-1' }]);
    expect((await get(`/api/sessions/${ID1}/subagents/agent-1`)).json().events).toEqual([
      { k: 'assistant_text', text: 'Found it' },
    ]);
    expect((await get(`/api/sessions/${ID1}/subagents/..%2f..`)).statusCode).toBe(404);
  });
});

describe('models and usage', () => {
  it('lists models with effort levels, and plan usage', async () => {
    await setup();
    const m = (await get('/api/models')).json().models;
    expect(m[0]).toMatchObject({
      value: 'sonnet',
      supportsEffort: true,
      effortLevels: ['low', 'medium', 'high'],
    });
    expect((await get('/api/usage')).json()).toEqual({ plan: { status: 'unavailable' } });
  });
});
