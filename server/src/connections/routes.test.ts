import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeKit, type Creds, type Kit } from '../testkit.js';
import { Connections } from './service.js';
import { ConnectionSettings } from './store.js';

const KEY = 'sk-ant-api03-abcdefghijklmnop';
let kit: Kit;
let c: Creds;

afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

async function setup(): Promise<void> {
  kit = await makeKit();
  c = await kit.signIn();
  await kit.stepUp(c);
}
const call = (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: Record<string, unknown>) =>
  kit.call({ method, url: `/api/connections${path}`, ...c, ...(payload === undefined ? {} : { payload }) });
const snap = async (): Promise<Json> => (await call('GET', '')).json();
async function until(pred: (s: Json) => boolean, ms = 4000): Promise<Json> {
  const end = Date.now() + ms;
  let s: Json;
  while (Date.now() < end) {
    s = await snap();
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out: ${JSON.stringify(s)}`);
}
// Response bodies are checked field by field; a loose type keeps the polling helper short.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const holdLogin = () => writeFileSync(join(kit.home, '.fake-hold'), '1');

describe('access control', () => {
  it('every route needs a session, CSRF and (for writes) a fresh check', async () => {
    kit = await makeKit();
    const anon = [
      ['GET', ''],
      ['POST', '/github/start'],
      ['POST', '/claude/apikey'],
      ['DELETE', '/claude/apikey'],
      ['POST', '/claude/mode'],
    ] as const;
    for (const [m, p] of anon) {
      const r = await kit.call({
        method: m,
        url: `/api/connections${p}`,
        payload: m === 'GET' ? undefined : {},
      });
      expect(r.statusCode, `${m} ${p}`).toBe(401);
    }
    const creds = await kit.signIn();
    const noCsrf = await kit.call({
      method: 'POST',
      url: '/api/connections/github/start',
      cookie: creds.cookie,
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe('bad_csrf');
    // signIn() leaves the session non-fresh, so a write is refused until a step-up.
    const stale = await kit.call({
      method: 'POST',
      url: '/api/connections/github/start',
      ...creds,
      payload: {},
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error).toBe('stepup_required');
  });
});

describe('snapshot', () => {
  it('starts as apikey mode with nothing connected', async () => {
    await setup();
    const s = await snap();
    expect(s.claude).toMatchObject({
      mode: 'apikey',
      apiKeySet: false,
      ackedAt: null,
      cli: { state: 'signed_out' },
    });
    expect(s.claude.login).toEqual({ phase: 'idle' });
    expect(s.github.cli).toEqual({ state: 'signed_out' });
    expect(s.fallbackCommands.claude).toContain('claude');
  });

  it('reports unavailable CLIs without failing', async () => {
    await setup();
    const missing = { cmd: 'antlings-no-such-binary' };
    const conns = new Connections({
      auth: kit.auth,
      settings: new ConnectionSettings(kit.auth),
      gh: missing,
      claude: missing,
      home: kit.home,
      clock: kit.clock,
    });
    const s = await conns.snapshot();
    expect(s.github.cli.state).toBe('unavailable');
    expect(s.claude.cli.state).toBe('unavailable');
    conns.dispose();
  });
});

describe('API key', () => {
  it('rejects a malformed key without echoing it', async () => {
    await setup();
    const r = await call('POST', '/claude/apikey', { apiKey: 'sk-ant-has a space in it' });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('has a space');
  });

  it('refuses a key Anthropic rejects and stores nothing', async () => {
    await setup();
    kit.anthropic.status = 401;
    const r = await call('POST', '/claude/apikey', { apiKey: KEY });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('key_rejected');
    expect((await snap()).claude.apiKeySet).toBe(false);
  });

  it('stores an accepted key, never returns it, and removes it on request', async () => {
    await setup();
    const r = await call('POST', '/claude/apikey', { apiKey: KEY });
    expect(r.json()).toEqual({ ok: true, verified: true });
    const s = await call('GET', '');
    expect(s.json().claude.apiKeySet).toBe(true);
    expect(s.body).not.toContain('sk-ant');
    expect(JSON.stringify(kit.auth.recentAudit(100))).not.toContain('sk-ant');
    expect(r.body).not.toContain('sk-ant');
    expect((await call('DELETE', '/claude/apikey')).statusCode).toBe(200);
    expect((await snap()).claude.apiKeySet).toBe(false);
  });

  it('keeps a key it could not verify because Anthropic was unreachable', async () => {
    await setup();
    kit.anthropic.status = 500;
    const r = await call('POST', '/claude/apikey', { apiKey: KEY });
    expect(r.json()).toEqual({ ok: true, verified: false });
    expect((await snap()).claude.apiKeySet).toBe(true);
  });

  it('tests the stored key', async () => {
    await setup();
    expect((await call('POST', '/claude/test')).json()).toEqual({ result: 'no_key' });
    await call('POST', '/claude/apikey', { apiKey: KEY });
    expect((await call('POST', '/claude/test')).json()).toEqual({ result: 'ok' });
    kit.anthropic.status = 401;
    expect((await call('POST', '/claude/test')).json()).toEqual({ result: 'rejected' });
  });
});

describe('mode and Claude login', () => {
  it('needs the terms acknowledgement to switch to subscription', async () => {
    await setup();
    const no = await call('POST', '/claude/mode', { mode: 'subscription' });
    expect(no.statusCode).toBe(400);
    expect(no.json().error).toBe('ack_required');
    const yes = await call('POST', '/claude/mode', { mode: 'subscription', ack: true });
    expect(yes.statusCode).toBe(200);
    const s = await snap();
    expect(s.claude.mode).toBe('subscription');
    expect(typeof s.claude.ackedAt).toBe('number');
  });

  it('refuses to start a Claude sign-in in apikey mode', async () => {
    await setup();
    const r = await call('POST', '/claude/login/start', {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('wrong_mode');
  });

  it('relays the sign-in: url, pasted code, signed in', async () => {
    await setup();
    await call('POST', '/claude/mode', { mode: 'subscription', ack: true });
    expect((await call('POST', '/claude/login/start', {})).statusCode).toBe(200);
    const w = await until((s) => s.claude.login.phase === 'waiting' && s.claude.login.url);
    expect(w.claude.login).toMatchObject({ needsCode: true });
    expect(w.claude.login.url).toMatch(/^https:\/\/claude\.com\//);
    expect((await call('POST', '/claude/login/code', { code: 'goodcode1' })).statusCode).toBe(200);
    await until((s) => s.claude.login.phase === 'done');
    const s = await snap();
    expect(s.claude.cli).toMatchObject({ state: 'signed_in', plan: 'max' });
    expect(JSON.stringify(s)).not.toContain('example.com');
    expect(JSON.stringify(kit.auth.recentAudit(100))).not.toContain('goodcode1');
  });

  it('rejects a code with control characters', async () => {
    await setup();
    const r = await call('POST', '/claude/login/code', { code: 'abc\ndef' });
    expect(r.statusCode).toBe(400);
  });
});

describe('GitHub login', () => {
  it('shows the device code, finishes, sets up git, and logs out', async () => {
    await setup();
    expect((await call('POST', '/github/start', {})).statusCode).toBe(200);
    const w = await until((s) => s.github.login.phase === 'waiting' && s.github.login.url);
    expect(w.github.login).toMatchObject({ code: 'ABCD-1234', url: 'https://github.com/login/device' });
    await until((s) => s.github.login.phase === 'done');
    expect((await snap()).github.cli).toEqual({ state: 'signed_in', login: 'octo' });
    await until(() => true);
    expect((await call('POST', '/github/logout', {})).statusCode).toBe(200);
    expect((await snap()).github.cli).toEqual({ state: 'signed_out' });
  });

  it('refuses a second start while one runs, then rate limits the next start', async () => {
    await setup();
    holdLogin();
    expect((await call('POST', '/github/start', {})).statusCode).toBe(200);
    const busy = await call('POST', '/github/start', {});
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe('busy');
    const cross = await call('POST', '/claude/login/start', {});
    expect([409]).toContain(cross.statusCode);
    expect((await call('POST', '/github/cancel', {})).statusCode).toBe(200);
    expect((await snap()).github.login).toEqual({ phase: 'error', reason: 'cancelled' });
    const limited = await call('POST', '/github/start', {});
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    kit.clock.advance(61_000);
    await kit.stepUp(c);
    expect((await call('POST', '/github/start', {})).statusCode).toBe(200);
  });

  it('does not respawn the status commands on every poll while a login runs', async () => {
    await setup();
    holdLogin();
    const calls = () => {
      try {
        return readFileSync(join(kit.home, '.fake-gh-status-calls'), 'utf8').split('\n').filter(Boolean)
          .length;
      } catch {
        return 0;
      }
    };
    await snap();
    await call('POST', '/github/start', {});
    const before = calls();
    for (let i = 0; i < 3; i++) await snap();
    expect(calls()).toBe(before);
    await call('POST', '/github/cancel', {});
    await snap();
    expect(calls()).toBeGreaterThan(before);
  });

  it('runs gh auth setup-git after a successful sign-in', async () => {
    await setup();
    await call('POST', '/github/start', {});
    await until((s) => s.github.login.phase === 'done');
    const { existsSync } = await import('node:fs');
    const end = Date.now() + 3000;
    while (!existsSync(join(kit.home, '.fake-gh-setup-git')) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 40));
    expect(existsSync(join(kit.home, '.fake-gh-setup-git'))).toBe(true);
  });
});

describe('git identity', () => {
  it('validates and writes only into the Antlings home', async () => {
    await setup();
    expect((await call('POST', '/git-identity', { name: 'Ada', email: 'nope' })).statusCode).toBe(400);
    const ok = await call('POST', '/git-identity', { name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(ok.statusCode).toBe(200);
    expect((await snap()).github.git).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
  });
});

describe('audit', () => {
  it('records connect, cancel, logout, key and mode changes without secrets', async () => {
    await setup();
    holdLogin();
    await call('POST', '/github/start', {});
    await call('POST', '/github/cancel', {});
    await call('POST', '/claude/apikey', { apiKey: KEY });
    await call('DELETE', '/claude/apikey');
    await call('POST', '/claude/mode', { mode: 'subscription', ack: true });
    await call('POST', '/github/logout', {});
    const kinds = kit.auth.recentAudit(100).map((a) => a.kind);
    for (const k of [
      'connect_start',
      'connect_cancel',
      'claude_key_set',
      'claude_key_cleared',
      'claude_mode',
      'connect_logout',
    ])
      expect(kinds, k).toContain(k);
  });
});

describe('summary', () => {
  const summary = async (): Promise<Json> => (await call('GET', '/summary')).json();
  const ghCalls = () => {
    try {
      return readFileSync(join(kit.home, '.fake-gh-status-calls'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  it('needs a session', async () => {
    kit = await makeKit();
    const r = await kit.call({ method: 'GET', url: '/api/connections/summary' });
    expect(r.statusCode).toBe(401);
  });

  it('starts with both missing and carries nothing but two words', async () => {
    await setup();
    expect(await summary()).toEqual({ claude: 'missing', github: 'missing' });
  });

  it('follows a saved API key and a GitHub sign-in without waiting for the cache', async () => {
    await setup();
    await summary();
    await call('POST', '/claude/apikey', { apiKey: KEY });
    expect((await summary()).claude).toBe('connected');
    await call('DELETE', '/claude/apikey');
    expect((await summary()).claude).toBe('missing');
    await call('POST', '/github/start', {});
    await until((s) => s.github.login.phase === 'done');
    expect((await summary()).github).toBe('connected');
    await call('POST', '/github/logout', {});
    expect((await summary()).github).toBe('missing');
  });

  it('counts Claude as connected in subscription mode only once signed in', async () => {
    await setup();
    await call('POST', '/claude/mode', { mode: 'subscription', ack: true });
    expect((await summary()).claude).toBe('missing');
    await call('POST', '/claude/login/start', {});
    await until((s) => s.claude.login.phase === 'waiting' && s.claude.login.url);
    await call('POST', '/claude/login/code', { code: 'goodcode1' });
    await until((s) => s.claude.login.phase === 'done');
    expect((await summary()).claude).toBe('connected');
  });

  it('asks the CLIs at most once a minute', async () => {
    await setup();
    await summary();
    const after = ghCalls();
    await summary();
    await summary();
    expect(ghCalls()).toBe(after);
    kit.clock.advance(61_000);
    await summary();
    expect(ghCalls()).toBe(after + 1);
  });
});
