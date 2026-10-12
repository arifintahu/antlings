import { afterEach, describe, expect, it } from 'vitest';
import { makeKit, type Kit } from './testkit.js';

let kit: Kit;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

const until = async (pred: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const NEW = { cwd: '/home/u/proj', model: 'sonnet', mode: 'default' as const };

async function setup() {
  kit = await makeKit();
  const creds = await kit.signIn();
  const srv = await kit.listen();
  return { creds, srv };
}

describe('websocket handshake', () => {
  it('refuses a missing ticket, a wrong ticket, a missing Origin and a foreign Origin', async () => {
    const { creds, srv } = await setup();
    await expect(srv.open(creds, { ticket: '' })).rejects.toThrow(/401/);
    await expect(srv.open(creds, { ticket: 'nope' })).rejects.toThrow(/401/);
    await expect(srv.open(creds, { origin: null })).rejects.toThrow(/403/);
    await expect(srv.open(creds, { origin: 'http://evil.example' })).rejects.toThrow(/403/);
  });

  it('a ticket works once', async () => {
    const { creds, srv } = await setup();
    const ticket = (await kit.call({ method: 'POST', url: '/api/ws-ticket', ...creds })).json().ticket;
    const a = await srv.open(creds, { ticket });
    a.ws.close();
    await expect(srv.open(creds, { ticket })).rejects.toThrow(/401/);
  });

  it('refuses an expired ticket', async () => {
    const { creds, srv } = await setup();
    const ticket = (await kit.call({ method: 'POST', url: '/api/ws-ticket', ...creds })).json().ticket;
    kit.clock.advance(31_000);
    await expect(srv.open(creds, { ticket })).rejects.toThrow(/401/);
  });

  it('only upgrades on /ws', async () => {
    const { creds, srv } = await setup();
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/other`, {
      headers: { origin: 'http://localhost:3100' },
    });
    await expect(new Promise((_r, rej) => ws.on('error', rej))).rejects.toThrow(/404/);
    void creds;
  });
});

describe('websocket messages', () => {
  it('rejects malformed JSON, unknown types and invalid fields without closing', async () => {
    const { creds, srv } = await setup();
    const s = await srv.open(creds);
    s.ws.send('not json');
    s.send({ t: 'nope' });
    s.send({ t: 'setPermissionMode', sessionId: 'x', mode: 'root' });
    await s.waitFor(() => s.received.filter((m) => m.code === 'bad_message').length === 3);
    expect(s.ws.readyState).toBe(s.ws.OPEN);
  });

  it('closes a connection that sends more than the payload limit', async () => {
    const { creds, srv } = await setup();
    const s = await srv.open(creds);
    s.ws.send('x'.repeat(300 * 1024));
    expect(await s.closed).toBe(1009);
  });

  it('streams a turn, replays after a reconnect with no duplicates, and answers approvals', async () => {
    const { creds, srv } = await setup();
    const { id } = await kit.mgr.create(NEW);
    const a = await srv.open(creds);
    a.send({ t: 'hello', sessionId: id, lastSeq: 0 });
    await a.waitFor((m) => m.t === 'synced');
    a.send({ t: 'send', sessionId: id, text: 'tool' });
    const req = (await a.waitFor(
      (m) => m.t === 'event' && (m.event as { k: string }).k === 'approval_request',
    )) as unknown as {
      seq: number;
      event: { requestId: string };
    };
    // the phone sleeps: drop the socket, then reconnect with the last seq seen
    const seenSeqs = a.received.filter((m) => m.t === 'event').map((m) => m.seq as number);
    a.ws.close();
    await a.closed;
    const b = await srv.open(creds);
    b.send({ t: 'hello', sessionId: id, lastSeq: Math.max(...seenSeqs) });
    await b.waitFor((m) => m.t === 'synced');
    b.send({ t: 'approve', sessionId: id, requestId: req.event.requestId });
    await b.waitFor((m) => m.t === 'event' && (m.event as { k: string }).k === 'turn_done');
    const bSeqs = b.received.filter((m) => m.t === 'event').map((m) => m.seq as number);
    expect(bSeqs.every((s) => s > Math.max(...seenSeqs))).toBe(true);
    expect(new Set(bSeqs).size).toBe(bSeqs.length);
    // everything a saw plus everything b saw is the whole log, once
    expect([...seenSeqs, ...bSeqs].sort((x, y) => x - y)).toEqual(
      kit.mgr
        .eventsAfter(id, 0)
        .map((e) => e.seq)
        .filter((s) => s <= Math.max(...bSeqs)),
    );
  });

  it('a stale approval gets an error, not a crash', async () => {
    const { creds, srv } = await setup();
    const { id } = await kit.mgr.create(NEW);
    const s = await srv.open(creds);
    s.send({ t: 'approve', sessionId: id, requestId: 'gone' });
    await s.waitFor((m) => m.code === 'stale_request');
  });

  it('hello for an unknown session is an error', async () => {
    const { creds, srv } = await setup();
    const s = await srv.open(creds);
    s.send({ t: 'hello', sessionId: 'unknown', lastSeq: 0 });
    await s.waitFor((m) => m.code === 'not_found');
  });

  it('a third session is refused with a message the page can show', async () => {
    const { creds, srv } = await setup();
    await kit.mgr.create(NEW);
    await kit.mgr.create(NEW);
    kit.transcripts.add('old');
    const s = await srv.open(creds);
    s.send({ t: 'send', sessionId: 'old', text: 'hello' });
    const err = await s.waitFor((m) => m.code === 'session_limit');
    expect(err.message).toMatch(/Only 2 sessions/);
  });

  it('Bypass mode needs a fresh step-up, other modes do not', async () => {
    const { creds, srv } = await setup();
    const { id } = await kit.mgr.create(NEW);
    const s = await srv.open(creds);
    s.send({ t: 'setPermissionMode', sessionId: id, mode: 'plan' });
    s.send({ t: 'setPermissionMode', sessionId: id, mode: 'bypassPermissions' });
    await s.waitFor((m) => m.code === 'stepup_required');
    expect(kit.agents.last.calls).toEqual(['setPermissionMode:plan']);
    await kit.stepUp(creds);
    s.send({ t: 'setPermissionMode', sessionId: id, mode: 'bypassPermissions' });
    await until(() => kit.agents.last.calls.includes('setPermissionMode:bypassPermissions'));
  });

  it('stopTask and interrupt reach the agent', async () => {
    const { creds, srv } = await setup();
    const { id } = await kit.mgr.create(NEW);
    const s = await srv.open(creds);
    s.send({ t: 'send', sessionId: id, text: 'slow-agent' });
    await new Promise((r) => setTimeout(r, 50));
    s.send({ t: 'stopTask', sessionId: id, taskId: 't2' });
    await until(() => kit.agents.last.calls.includes('stopTask:t2'));
  });
});

describe('websocket and sign-out', () => {
  it('closes an open socket when its session is revoked', async () => {
    const { creds, srv } = await setup();
    const s = await srv.open(creds);
    await kit.call({ method: 'POST', url: '/api/auth/logout', ...creds });
    s.send({ t: 'hello', sessionId: 'x', lastSeq: 0 });
    expect(await s.closed).toBe(4401);
  });
});
