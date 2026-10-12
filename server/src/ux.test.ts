import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ServerMessage } from '@antlings/shared';
import { leadTextDelta } from './sessions.js';
import { makeKit, type Creds, type Kit } from './testkit.js';

let kit: Kit;
let creds: Creds;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

const NEW = { cwd: '/home/u/proj', model: 'sonnet', mode: 'default' as const };
const until = async (pred: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('live text streaming', () => {
  it('sends the lead answer as deltas that are not stored, and ignores subagent deltas', async () => {
    kit = await makeKit();
    const { id } = await kit.mgr.create(NEW);
    const got: ServerMessage[] = [];
    kit.mgr.subscribe(id, 0, (m) => got.push(m));
    await kit.mgr.send(id, 'stream');
    await until(() => kit.mgr.eventsAfter(id, 0).some((e) => e.event.k === 'turn_done'));
    const deltas = got.filter((m) => m.t === 'delta').map((m) => (m as { text: string }).text);
    expect(deltas).toEqual(['Hel', 'lo ', 'world']);
    expect(kit.mgr.eventsAfter(id, 0).some((e) => JSON.stringify(e).includes('"delta"'))).toBe(false);
    expect(kit.mgr.eventsAfter(id, 0).find((e) => e.event.k === 'assistant_text')?.event).toMatchObject({
      text: 'Hello world',
    });
  });

  it('leadTextDelta reads only lead text deltas', () => {
    const ev = (parent: string | null, delta: unknown) => ({
      parent_tool_use_id: parent,
      event: { type: 'content_block_delta', delta },
    });
    expect(leadTextDelta(ev(null, { type: 'text_delta', text: 'a' }))).toBe('a');
    expect(leadTextDelta(ev('x', { type: 'text_delta', text: 'a' }))).toBe('');
    expect(leadTextDelta(ev(null, { type: 'thinking_delta', thinking: 'a' }))).toBe('');
    expect(leadTextDelta({ event: { type: 'message_start' } })).toBe('');
    expect(leadTextDelta(null as never)).toBe('');
  });
});

describe('pins', () => {
  it('pins through the API, sorts pinned first, and forgets the pin on delete', async () => {
    kit = await makeKit();
    creds = await kit.signIn();
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    kit.transcripts.add(a, { cwd: join(kit.home, 'proj'), lastModified: 9 });
    kit.transcripts.add(b, { cwd: join(kit.home, 'proj'), lastModified: 1 });
    const list = async () =>
      (await kit.call({ method: 'GET', url: '/api/sessions', ...creds }))
        .json()
        .sessions.map((s: { id: string }) => s.id);
    expect(await list()).toEqual([a, b]);
    const r = await kit.call({
      method: 'PATCH',
      url: `/api/sessions/${b}`,
      ...creds,
      payload: { pinned: true },
    });
    expect(r.statusCode).toBe(200);
    expect(await list()).toEqual([b, a]);
    await kit.stepUp(creds);
    await kit.call({ method: 'DELETE', url: `/api/sessions/${b}`, ...creds });
    expect(kit.mgr.isPinned(b)).toBe(false);
  });
});

describe('event retention', () => {
  it('keeps only the newest events and keeps numbering', async () => {
    kit = await makeKit({}, { ANTLINGS_EVENT_KEEP: '500' });
    const { id } = await kit.mgr.create(NEW);
    for (let i = 0; i < 700; i++) kit.mgr.emit(id, { k: 'notice', message: `n${i}` });
    const removed = kit.mgr.pruneEvents(id);
    const left = kit.mgr.eventsAfter(id, 0, 10_000);
    expect(removed).toBe(201);
    expect(left).toHaveLength(500);
    expect(left[0]!.seq).toBe(202);
    expect(kit.mgr.emit(id, { k: 'notice', message: 'next' }).seq).toBe(702);
  });
});

describe('status and push test', () => {
  it('reports version, memory, sessions and the database, for signed-in users only', async () => {
    kit = await makeKit();
    creds = await kit.signIn();
    expect((await kit.call({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    await kit.mgr.create(NEW);
    const s = (await kit.call({ method: 'GET', url: '/api/status', ...creds })).json();
    expect(s).toMatchObject({ sessions: { running: 1, max: 2 }, eventKeep: 20000 });
    expect(s.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(s.serviceMemoryMb).toBeGreaterThan(0);
    expect(s.hostMemory.totalMb).toBeGreaterThan(0);
    expect(s.database.events).toBeGreaterThan(0);
  });

  it('sends a test notification to every device', async () => {
    kit = await makeKit();
    creds = await kit.signIn();
    await kit.call({
      method: 'POST',
      url: '/api/push/subscribe',
      ...creds,
      payload: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) },
      },
    });
    const r = await kit.call({ method: 'POST', url: '/api/push/test', ...creds, payload: {} });
    expect(r.json()).toEqual({ sent: 1 });
    expect(kit.pushSent.at(-1)?.payload).toMatchObject({ title: 'Antlings test' });
  });
});
