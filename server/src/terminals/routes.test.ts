import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_CLOSE_MS } from '../sessions.js';
import { makeKit, ORIGIN, type Creds, type Kit } from '../testkit.js';

let kit: Kit;
let creds: Creds;
let id: string;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

const SIZE = { cols: 80, rows: 24 };
const get = (url: string) => kit.call({ method: 'GET', url, ...creds });
const post = (url: string, payload: unknown) =>
  kit.call({ method: 'POST', url, payload: payload as object, ...creds });
const patch = (url: string, payload: unknown) =>
  kit.call({ method: 'PATCH', url, payload: payload as object, ...creds });
const del = (url: string) => kit.call({ method: 'DELETE', url, ...creds });
const base = () => `/api/sessions/${id}/terminals`;

async function setup(): Promise<string> {
  kit = await makeKit();
  creds = await kit.signIn();
  const r = await post('/api/sessions', { folder: 'proj', model: 'sonnet', mode: 'default' });
  id = r.json().id;
  kit.transcripts.add(id, { cwd: join(kit.home, 'proj') });
  return id;
}

describe('protection', () => {
  it('refuses a missing session, a missing CSRF header and a foreign Origin', async () => {
    await setup();
    expect((await kit.call({ method: 'GET', url: base() })).statusCode).toBe(401);
    expect((await kit.call({ method: 'POST', url: base(), payload: SIZE })).statusCode).toBe(401);
    expect((await kit.call({ method: 'DELETE', url: `${base()}/0123456789abcdef` })).statusCode).toBe(401);
    const noCsrf = await kit.call({ method: 'POST', url: base(), payload: SIZE, cookie: creds.cookie });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe('bad_csrf');
    const foreign = await kit.call({
      method: 'POST',
      url: base(),
      payload: SIZE,
      ...creds,
      headers: { origin: 'http://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error).toBe('bad_origin');
    expect(ORIGIN).toBeDefined();
  });
});

describe('opening and closing', () => {
  it('starts the shell in the stored folder and ignores a folder sent by the client', async () => {
    await setup();
    const r = await post(base(), { ...SIZE, cwd: '/etc' });
    expect(r.statusCode).toBe(200);
    expect(r.json().terminal).toMatchObject({ running: true, name: 'Shell 1' });
    expect(kit.pty.spawned[0]!.opts.cwd).toBe(join(kit.home, 'proj'));
    expect((await get(base())).json().terminals).toHaveLength(1);
  });

  it('answers 404 for bad session ids, unknown sessions and bad terminal ids', async () => {
    await setup();
    expect((await get('/api/sessions/..%2fx/terminals')).statusCode).toBe(404);
    expect(
      (await post('/api/sessions/33333333-3333-4333-8333-333333333333/terminals', SIZE)).statusCode,
    ).toBe(404);
    expect((await del(`${base()}/..%2fx`)).statusCode).toBe(404);
    expect((await del(`${base()}/ABCDEF0123456789`)).statusCode).toBe(404);
    expect((await del(`${base()}/0123456789abcdef`)).statusCode).toBe(404);
  });

  it('refuses a session outside home', async () => {
    await setup();
    const other = '44444444-4444-4444-8444-444444444444';
    kit.transcripts.add(other, { cwd: '/etc' });
    expect((await post(`/api/sessions/${other}/terminals`, SIZE)).statusCode).toBe(404);
    expect(kit.pty.spawned).toHaveLength(0);
  });

  it('rejects a bad body with 400', async () => {
    await setup();
    expect((await post(base(), { cols: 0, rows: 24 })).statusCode).toBe(400);
    expect((await post(base(), {})).statusCode).toBe(400);
  });

  it('closes one shell on DELETE', async () => {
    await setup();
    const t = (await post(base(), SIZE)).json().terminal;
    expect((await del(`${base()}/${t.id}`)).json()).toEqual({ ok: true });
    expect(kit.pty.spawned[0]!.killed).toBe(true);
    expect((await get(base())).json().terminals).toEqual([]);
  });
});

describe('archive and delete', () => {
  it('archiving kills the shells and blocks new ones until it is unarchived', async () => {
    await setup();
    await post(base(), SIZE);
    await post(base(), SIZE);
    const other = '55555555-5555-4555-8555-555555555555';
    kit.transcripts.add(other, { cwd: join(kit.home, 'proj') });
    kit.terms.create(other, join(kit.home, 'proj'), SIZE);
    expect((await patch(`/api/sessions/${id}`, { archived: true })).statusCode).toBe(200);
    expect(kit.pty.spawned.slice(0, 2).every((p) => p.killed)).toBe(true);
    expect((await get(base())).json().terminals).toEqual([]);
    const blocked = await post(base(), SIZE);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('archived');
    expect(kit.terms.list(other)).toHaveLength(1);
    expect(kit.pty.spawned[2]!.killed).toBe(false);
    await patch(`/api/sessions/${id}`, { archived: false });
    expect((await post(base(), SIZE)).statusCode).toBe(200);
  });

  it('deleting the session kills its shells', async () => {
    await setup();
    await post(base(), SIZE);
    await kit.stepUp(creds);
    expect((await del(`/api/sessions/${id}`)).statusCode).toBe(200);
    expect(kit.pty.spawned[0]!.killed).toBe(true);
    expect(kit.terms.list(id)).toEqual([]);
  });
});

describe('limits and failures', () => {
  it('maps the shell cap to 409 terminal_limit', async () => {
    await setup();
    for (let i = 0; i < 4; i++) expect((await post(base(), SIZE)).statusCode).toBe(200);
    const r = await post(base(), SIZE);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('terminal_limit');
  });

  it('maps a spawn failure to 503 without the thrown message, and leaves nothing behind', async () => {
    await setup();
    kit.pty.failNext('ENOENT /usr/local/secret/bash');
    const r = await post(base(), SIZE);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('shell_unavailable');
    expect(r.body).not.toContain('secret');
    expect((await get(base())).json().terminals).toEqual([]);
  });
});

describe('audit and logs', () => {
  it('audits open and close and never records what is typed', async () => {
    await setup();
    const t = (await post(base(), SIZE)).json().terminal;
    kit.terms.write(id, t.id, 'secret-input\r');
    kit.pty.spawned[0]!.emit('secret-output');
    await del(`${base()}/${t.id}`);
    const rows = kit.auth.recentAudit();
    expect(
      rows
        .filter((r) => r.kind.startsWith('terminal_'))
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['terminal_closed', 'terminal_opened']);
    const dump = JSON.stringify(rows) + kit.logs.join('\n');
    expect(dump).not.toContain('secret-input');
    expect(dump).not.toContain('secret-output');
  });
});

describe('idle reaper', () => {
  it('leaves shells alone after the agent idle time', async () => {
    await setup();
    await post(base(), SIZE);
    kit.clock.advance(IDLE_CLOSE_MS * 2);
    kit.mgr.reapIdle();
    expect((await get(base())).json().terminals).toHaveLength(1);
    expect(kit.pty.spawned[0]!.killed).toBe(false);
  });
});
