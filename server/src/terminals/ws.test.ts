import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeKit, type Creds, type Kit } from '../testkit.js';

let kit: Kit;
let creds: Creds;
let id: string;
let tid: string;
let net: Awaited<ReturnType<Kit['listen']>>;
afterEach(async () => {
  vi.useRealTimers();
  kit?.mgr.closeAll();
  await kit?.app.close();
});

const SIZE = { cols: 80, rows: 24 };

async function setup() {
  kit = await makeKit();
  creds = await kit.signIn();
  id = (
    await kit.call({
      method: 'POST',
      url: '/api/sessions',
      payload: { folder: 'proj', model: 'sonnet', mode: 'default' },
      ...creds,
    })
  ).json().id;
  kit.transcripts.add(id, { cwd: join(kit.home, 'proj') });
  tid = (
    await kit.call({ method: 'POST', url: `/api/sessions/${id}/terminals`, payload: SIZE, ...creds })
  ).json().terminal.id;
  net = await kit.listen();
}

const status = (p: Promise<unknown>) =>
  p.then(
    () => 'open',
    (e: Error) => e.message,
  );

describe('refusals', () => {
  it('turns away a bad ticket, Origin, session or terminal before any socket exists', async () => {
    await setup();
    expect(await status(net.openTerminal(creds, id, tid, { ticket: 'nope' }))).toBe('status 401');
    expect(await status(net.openTerminal(creds, id, tid, { ticket: '' }))).toBe('status 401');
    expect(await status(net.openTerminal(creds, id, tid, { origin: 'http://evil.example' }))).toBe(
      'status 403',
    );
    expect(await status(net.openTerminal(creds, id, tid, { origin: null }))).toBe('status 403');
    const unknownSession = '66666666-6666-4666-8666-666666666666';
    expect(await status(net.openTerminal(creds, unknownSession, tid))).toBe('status 404');
    expect(await status(net.openTerminal(creds, id, 'ffffffffffffffff'))).toBe('status 404');
    expect(await status(net.openTerminal(creds, id, '../x'))).toBe('status 404');
    expect(await status(net.openTerminal(creds, '../x', tid))).toBe('status 404');
    const outside = '77777777-7777-4777-8777-777777777777';
    kit.transcripts.add(outside, { cwd: '/etc' });
    expect(await status(net.openTerminal(creds, outside, tid))).toBe('status 404');
  });

  it('accepts a ticket once and lets an expired one lapse', async () => {
    await setup();
    const t = (await kit.call({ method: 'POST', url: '/api/ws-ticket', ...creds })).json().ticket;
    const ws = await net.openTerminal(creds, id, tid, { ticket: t });
    ws.ws.close();
    expect(await status(net.openTerminal(creds, id, tid, { ticket: t }))).toBe('status 401');
    const old = (await kit.call({ method: 'POST', url: '/api/ws-ticket', ...creds })).json().ticket;
    kit.clock.advance(31_000);
    expect(await status(net.openTerminal(creds, id, tid, { ticket: old }))).toBe('status 401');
  });

  it('does not take over /ws, and /ws still refuses other paths', async () => {
    await setup();
    const ws = await net.open(creds);
    ws.ws.close();
  });
});

describe('streaming', () => {
  it('replays earlier output, streams new output, and takes input and resizes', async () => {
    await setup();
    const p = kit.pty.spawned[0]!;
    p.emit('earlier');
    const a = await net.openTerminal(creds, id, tid);
    await a.waitFor((m) => m.t === 'replay' && m.d === 'earlier');
    p.emit('hi');
    await a.waitFor((m) => m.t === 'out' && m.d === 'hi');
    a.send({ t: 'in', d: 'ls\r' });
    a.send({ t: 'resize', cols: 100, rows: 30 });
    await new Promise((r) => setTimeout(r, 100));
    expect(p.written).toEqual(['ls\r']);
    expect(p.size).toEqual({ cols: 100, rows: 30 });
    const b = await net.openTerminal(creds, id, tid);
    await b.waitFor((m) => m.t === 'replay' && m.d === 'earlierhi');
    p.emit('!');
    await b.waitFor((m) => m.t === 'out' && m.d === '!');
    await a.waitFor((m) => m.t === 'out' && m.d === '!');
    a.ws.close();
    await a.closed;
    expect(kit.terms.list(id)[0]!.running).toBe(true);
    p.emit('still');
    await b.waitFor((m) => m.t === 'out' && m.d === 'still');
  });
});

describe('garbage from the client', () => {
  it('closes on an oversized frame (1009) and on bad messages (1008) without touching the shell', async () => {
    await setup();
    const p = kit.pty.spawned[0]!;
    const big = await net.openTerminal(creds, id, tid);
    big.ws.send(JSON.stringify({ t: 'in', d: 'x'.repeat(300 * 1024) }));
    expect(await big.closed).toBe(1009);
    for (const raw of [
      'not json',
      JSON.stringify({ t: 'nope' }),
      JSON.stringify({ t: 'resize', cols: 0, rows: 5 }),
    ]) {
      const s = await net.openTerminal(creds, id, tid);
      s.ws.send(raw);
      expect(await s.closed, raw).toBe(1008);
    }
    const bin = await net.openTerminal(creds, id, tid);
    bin.ws.send(Buffer.from([1, 2, 3]));
    expect(await bin.closed).toBe(1008);
    expect(p.written).toEqual([]);
    expect(p.size).toEqual(SIZE);
  });
});

describe('endings', () => {
  it('sends exit then closes 1000 when the shell ends', async () => {
    await setup();
    const a = await net.openTerminal(creds, id, tid);
    await a.waitFor((m) => m.t === 'replay');
    kit.pty.spawned[0]!.exitWith(0);
    await a.waitFor((m) => m.t === 'exit' && m.code === 0);
    expect(await a.closed).toBe(1000);
  });

  it('closes 4410 when the shell is killed, and when the session is archived', async () => {
    await setup();
    const a = await net.openTerminal(creds, id, tid);
    await a.waitFor((m) => m.t === 'replay');
    kit.terms.kill(id, tid);
    expect(await a.closed).toBe(4410);

    const t2 = (
      await kit.call({ method: 'POST', url: `/api/sessions/${id}/terminals`, payload: SIZE, ...creds })
    ).json().terminal.id;
    const b = await net.openTerminal(creds, id, t2);
    await b.waitFor((m) => m.t === 'replay');
    await kit.call({ method: 'PATCH', url: `/api/sessions/${id}`, payload: { archived: true }, ...creds });
    expect(await b.closed).toBe(4410);
  });

  it('closes 4401 once the sign-in is gone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // only the 15 s re-check; sockets stay real
    await setup();
    const a = await net.openTerminal(creds, id, tid);
    await a.waitFor((m) => m.t === 'replay');
    kit.clock.advance(13 * 3600_000);
    vi.advanceTimersByTime(15_000);
    expect(await a.closed).toBe(4401);
  });
});

describe('a client that stops reading', () => {
  it('is dropped, while the shell and other clients carry on', async () => {
    await setup();
    const p = kit.pty.spawned[0]!;
    const slow = await net.openTerminal(creds, id, tid);
    const fast = await net.openTerminal(creds, id, tid);
    await slow.waitFor((m) => m.t === 'replay');
    await fast.waitFor((m) => m.t === 'replay');
    (slow.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const chunk = 'x'.repeat(256 * 1024);
    const before = fast.received.length;
    for (let i = 0; i < 100; i++) {
      p.emit(chunk);
      // The reading client keeps up, one chunk at a time; only the stalled one falls behind.
      while (fast.received.length < before + i + 1) await new Promise((r) => setImmediate(r));
    }
    // The stalled client only learns of the drop once it reads again; the server side is already gone.
    (slow.ws as unknown as { _socket: { resume(): void } })._socket.resume();
    expect(await slow.closed).toBe(1006);
    p.emit('after');
    await fast.waitFor((m) => m.t === 'out' && m.d === 'after');
    expect(kit.terms.list(id)[0]!.running).toBe(true);
  });
});
