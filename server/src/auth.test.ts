import { afterEach, describe, expect, it } from 'vitest';
import { COOKIE_NAME } from './app.js';
import { FRESH_MS, LOCKOUT_MS } from './auth/service.js';
import { makeKit, type Kit } from './testkit.js';

let kit: Kit;
afterEach(async () => kit?.app.close());

async function passkeyLogin(k: Kit, ip?: string) {
  const o = (await k.call({ method: 'POST', url: '/api/auth/passkey/options', remoteAddress: ip })).json();
  return k.call({
    method: 'POST',
    url: '/api/auth/passkey/verify',
    remoteAddress: ip,
    payload: {
      challengeId: o.challengeId,
      response: { id: 'key-1', challenge: k.challengeOf(o.challengeId) },
    },
  });
}

const PUBLIC_ROUTES = [
  'GET /health',
  'GET /api/auth/status',
  'POST /api/setup/options',
  'POST /api/setup/verify',
  'POST /api/auth/passkey/options',
  'POST /api/auth/passkey/verify',
  'POST /api/auth/password',
  'POST /api/auth/totp',
  'GET /*',
];

describe('route protection', () => {
  it('every route except the public allowlist returns 401 without a session', async () => {
    kit = await makeKit({}, { ANTLINGS_STATIC_DIR: '.' });
    const open: string[] = [];
    let count = 0;
    for (const r of kit.app.routeTable) {
      for (const method of [r.method].flat()) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        count++;
        const url = r.url.replace(/:\w+/g, 'x').replace('*', 'x');
        const res = await kit.call({
          method: method as 'GET',
          url,
          payload: method === 'GET' ? undefined : {},
        });
        if (res.statusCode !== 401) open.push(`${method} ${r.url}`);
      }
    }
    expect(open.sort()).toEqual([...PUBLIC_ROUTES].sort());
    expect(count).toBeGreaterThan(15);
  });

  it('decides from the routed handler, not from the raw URL (percent-encoded paths)', async () => {
    kit = await makeKit();
    for (const url of ['/%61pi/me', '/%61pi/security', '/%77s', '/api/%73ecurity', '/api//security']) {
      const r = await kit.call({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
  });

  it('unknown /api paths and non-GET unknown paths also need a session', async () => {
    kit = await makeKit();
    expect((await kit.call({ method: 'GET', url: '/api/nope' })).statusCode).toBe(401);
    expect((await kit.call({ method: 'PUT', url: '/anything', payload: {} })).statusCode).toBe(401);
  });
});

describe('first run', () => {
  it('setup code works once, then the setup API returns 404', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    expect(s.csrf).toBeTruthy();
    for (const url of ['/api/setup/options', '/api/setup/verify']) {
      expect((await kit.call({ method: 'POST', url, payload: { code: 'ANT-AAAA-BBBB' } })).statusCode).toBe(
        404,
      );
    }
    expect((await kit.call({ method: 'GET', url: '/api/auth/status' })).json().firstRun).toBe(false);
  });

  it('the session created by first-run setup counts as fresh for five minutes', async () => {
    kit = await makeKit();
    const { code } = kit.auth.createSetupCode();
    const o = (await kit.call({ method: 'POST', url: '/api/setup/options', payload: { code } })).json();
    const v = await kit.call({
      method: 'POST',
      url: '/api/setup/verify',
      payload: {
        code,
        challengeId: o.challengeId,
        response: { id: 'k', challenge: kit.challengeOf(o.challengeId) },
      },
    });
    const creds = {
      cookie: v.cookies.find((c) => c.name === COOKIE_NAME)!.value,
      csrf: v.json().csrf as string,
    };
    expect((await kit.call({ method: 'GET', url: '/api/me', ...creds })).json().fresh).toBe(true);
    kit.clock.advance(5 * 60_000 + 1);
    expect((await kit.call({ method: 'GET', url: '/api/me', ...creds })).json().fresh).toBe(false);
  });

  it('rejects an expired code', async () => {
    kit = await makeKit();
    const { code } = kit.auth.createSetupCode();
    kit.clock.advance(15 * 60_000 + 1);
    const r = await kit.call({ method: 'POST', url: '/api/setup/options', payload: { code } });
    expect(r.statusCode).toBe(403);
  });

  it('rejects a wrong code and stores only a hash of the real one', async () => {
    kit = await makeKit();
    const { code } = kit.auth.createSetupCode();
    const wrong = await kit.call({
      method: 'POST',
      url: '/api/setup/options',
      payload: { code: 'ANT-ZZZZ-ZZZZ' },
    });
    expect(wrong.statusCode).toBe(403);
    const raw = JSON.stringify(kit.auth.db.prepare('SELECT * FROM setup_codes').all());
    expect(raw).not.toContain(code.replace(/ANT-|-/g, ''));
  });

  it('a used code cannot be replayed even if the credentials are later gone', async () => {
    kit = await makeKit();
    const { code } = kit.auth.createSetupCode();
    const o = (await kit.call({ method: 'POST', url: '/api/setup/options', payload: { code } })).json();
    const body = {
      code,
      challengeId: o.challengeId,
      response: { id: 'k', challenge: kit.challengeOf(o.challengeId) },
    };
    expect((await kit.call({ method: 'POST', url: '/api/setup/verify', payload: body })).statusCode).toBe(
      200,
    );
    kit.auth.db.prepare('DELETE FROM passkeys').run();
    const again = await kit.call({ method: 'POST', url: '/api/setup/options', payload: { code } });
    expect(again.json().error).toBe('bad_code');
  });

  it('reset-access removes credentials and sessions and opens setup again', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    const { code } = kit.auth.resetAccess();
    expect((await kit.call({ method: 'GET', url: '/api/me', ...s })).statusCode).toBe(401);
    expect((await kit.call({ method: 'GET', url: '/api/auth/status' })).json().firstRun).toBe(true);
    expect(
      (await kit.call({ method: 'POST', url: '/api/setup/options', payload: { code } })).statusCode,
    ).toBe(200);
  });
});

describe('sign-in, cookie and csrf', () => {
  it('sets a hardened cookie', async () => {
    kit = await makeKit();
    await kit.signIn();
    const res = await passkeyLogin(kit);
    expect(res.statusCode).toBe(200);
    const raw = String(res.headers['set-cookie']);
    expect(raw).toContain(`${COOKIE_NAME}=`);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Domain=/i);
  });

  it('refuses a state-changing request without the CSRF token', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    expect((await kit.call({ method: 'POST', url: '/api/auth/logout', cookie: s.cookie })).statusCode).toBe(
      403,
    );
    const wrong = await kit.call({
      method: 'POST',
      url: '/api/auth/logout',
      cookie: s.cookie,
      csrf: 'wrong',
    });
    expect(wrong.statusCode).toBe(403);
    expect((await kit.call({ method: 'POST', url: '/api/auth/logout', ...s })).statusCode).toBe(200);
  });

  it('refuses a state-changing request from another origin or with none', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    for (const origin of ['http://evil.example', undefined]) {
      const res = await kit.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          cookie: `${COOKIE_NAME}=${s.cookie}`,
          'x-csrf-token': s.csrf,
          ...(origin ? { origin } : {}),
        },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('revoking a session takes effect on the next request', async () => {
    kit = await makeKit();
    const a = await kit.signIn();
    const login = await passkeyLogin(kit);
    const bCookie = /=([^;]+)/.exec(String(login.headers['set-cookie']))![1]!;
    expect((await kit.call({ method: 'GET', url: '/api/me', cookie: bCookie })).statusCode).toBe(200);
    const sec = (await kit.call({ method: 'GET', url: '/api/security', ...a })).json();
    const other = sec.sessions.find((x: { current: boolean }) => !x.current);
    await kit.call({ method: 'POST', url: '/api/auth/logout-device', ...a, payload: { id: other.id } });
    expect((await kit.call({ method: 'GET', url: '/api/me', cookie: bCookie })).statusCode).toBe(401);
    expect((await kit.call({ method: 'GET', url: '/api/me', ...a })).statusCode).toBe(200);
  });

  it('ends a session after 30 days even if it is used all the time', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    for (let i = 0; i < 71; i++) {
      kit.clock.advance(10 * 3_600_000);
      expect((await kit.call({ method: 'GET', url: '/api/me', ...s })).statusCode).toBe(200);
    }
    kit.clock.advance(11 * 3_600_000);
    expect((await kit.call({ method: 'GET', url: '/api/me', ...s })).statusCode).toBe(401);
  });

  it('expires a session after the idle timeout, and activity extends it', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    kit.clock.advance(11 * 3_600_000);
    expect((await kit.call({ method: 'GET', url: '/api/me', ...s })).statusCode).toBe(200);
    kit.clock.advance(11 * 3_600_000);
    expect((await kit.call({ method: 'GET', url: '/api/me', ...s })).statusCode).toBe(200);
    kit.clock.advance(12 * 3_600_000 + 1);
    expect((await kit.call({ method: 'GET', url: '/api/me', ...s })).statusCode).toBe(401);
  });

  it('adds security headers and hides stack traces', async () => {
    kit = await makeKit();
    const h = (await kit.call({ method: 'GET', url: '/health' })).headers;
    expect(h['content-security-policy']).toContain("script-src 'self'");
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['permissions-policy']).toBeTruthy();
    const bad = await kit.call({
      method: 'POST',
      url: '/api/auth/password',
      payload: '{bad',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/node_modules|\.ts:\d+/);
  });

  it('sends no CORS headers', async () => {
    kit = await makeKit();
    const r = await kit.call({ method: 'GET', url: '/health', headers: { origin: 'http://evil.example' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('lockout', () => {
  it('blocks an address after five failures and releases it after 15 minutes', async () => {
    kit = await makeKit();
    await kit.signIn();
    const bad = () =>
      kit.call({
        method: 'POST',
        url: '/api/auth/passkey/verify',
        payload: { challengeId: 'nope-nope-nope', response: {} },
      });
    for (let i = 0; i < 5; i++) expect((await bad()).statusCode).toBe(401);
    const blocked = await bad();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect((await passkeyLogin(kit)).statusCode).toBe(429);
    kit.clock.advance(LOCKOUT_MS - 1);
    expect((await bad()).statusCode).toBe(429);
    kit.clock.advance(2);
    expect((await passkeyLogin(kit)).statusCode).toBe(200);
  });

  it('counts parallel attempts, so a burst cannot get past the limit', async () => {
    kit = await makeKit();
    const rs = await Promise.all(
      Array.from({ length: 30 }, () =>
        kit.call({ method: 'POST', url: '/api/auth/password', payload: { password: 'wrong wrong wrong' } }),
      ),
    );
    expect(rs.filter((r) => r.statusCode === 401).length).toBeLessThanOrEqual(5);
    expect(rs.filter((r) => r.statusCode === 429).length).toBeGreaterThanOrEqual(25);
  });

  it('treats a whole IPv6 /64 as one address', async () => {
    kit = await makeKit();
    const bad = (ip: string) =>
      kit.call({ method: 'POST', url: '/api/auth/password', remoteAddress: ip, payload: { password: 'x' } });
    for (let i = 1; i <= 5; i++) await bad(`2001:db8:1:2::${i}`);
    expect((await bad('2001:db8:1:2:aaaa::9')).statusCode).toBe(429);
    expect((await bad('2001:db8:1:3::1')).statusCode).toBe(401);
  });

  it('a successful sign-in does not count toward the limit', async () => {
    kit = await makeKit();
    await kit.signIn();
    for (let i = 0; i < 10; i++) expect((await passkeyLogin(kit)).statusCode).toBe(200);
  });

  it('writes a line fail2ban can match, with the address', async () => {
    kit = await makeKit();
    await kit.call({ method: 'POST', url: '/api/auth/password', payload: { password: 'x' } });
    expect(kit.logs.some((l) => /^antlings-auth-fail ip=127\.0\.0\.1 reason=password$/.test(l))).toBe(true);
  });

  it('locks per address and ignores X-Forwarded-For from a non-loopback peer', async () => {
    kit = await makeKit();
    const bad = (ip: string, xff?: string) =>
      kit.call({
        method: 'POST',
        url: '/api/auth/password',
        remoteAddress: ip,
        headers: xff ? { 'x-forwarded-for': xff } : {},
        payload: { password: 'x' },
      });
    for (let i = 0; i < 5; i++) await bad('10.0.0.5', `1.2.3.${i}`);
    expect((await bad('10.0.0.5', '9.9.9.9')).statusCode).toBe(429);
    expect((await bad('10.0.0.6')).statusCode).toBe(401);
  });

  it('trusts X-Forwarded-For from the loopback proxy', async () => {
    kit = await makeKit();
    await kit.call({
      method: 'POST',
      url: '/api/auth/password',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      payload: { password: 'x' },
    });
    expect(kit.logs[0]).toContain('ip=203.0.113.9');
  });
});

describe('step-up', () => {
  it('guards logout-all, adding and removing passkeys, and the fallback', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    const guarded: [string, string, object?][] = [
      ['POST', '/api/auth/logout-all'],
      ['POST', '/api/security/passkeys/options'],
      ['POST', '/api/security/passkeys/verify', { challengeId: 'xxxxxxxx', response: {} }],
      ['DELETE', '/api/security/passkeys/key-1'],
      ['POST', '/api/security/fallback', { password: 'correct horse battery' }],
      ['POST', '/api/security/fallback/confirm', { code: '123456' }],
      ['PATCH', '/api/security/settings', { idleTimeoutHours: 720 }],
    ];
    for (const [method, url, payload] of guarded) {
      const r = await kit.call({ method: method as 'POST', url, ...s, payload: payload ?? {} });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error).toBe('stepup_required');
    }
    await kit.stepUp(s);
    expect((await kit.call({ method: 'GET', url: '/api/me', ...s })).json().fresh).toBe(true);
    expect((await kit.call({ method: 'POST', url: '/api/security/passkeys/options', ...s })).statusCode).toBe(
      200,
    );
  });

  it('freshness lasts five minutes', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    await kit.stepUp(s);
    kit.clock.advance(FRESH_MS - 1);
    expect((await kit.call({ method: 'POST', url: '/api/security/passkeys/options', ...s })).statusCode).toBe(
      200,
    );
    kit.clock.advance(2);
    expect((await kit.call({ method: 'POST', url: '/api/security/passkeys/options', ...s })).statusCode).toBe(
      403,
    );
  });

  it('a failed step-up is logged and does not grant freshness', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    const r = await kit.call({
      method: 'POST',
      url: '/api/auth/stepup/passkey/verify',
      ...s,
      payload: { challengeId: 'nope-nope-nope', response: {} },
    });
    expect(r.statusCode).toBe(401);
    expect(kit.logs.some((l) => l.includes('reason=stepup-passkey'))).toBe(true);
    expect((await kit.call({ method: 'GET', url: '/api/me', ...s })).json().fresh).toBe(false);
  });

  it('a step-up challenge made for one session cannot be used by another', async () => {
    kit = await makeKit();
    const a = await kit.signIn();
    const login = await passkeyLogin(kit);
    const b = {
      cookie: /=([^;]+)/.exec(String(login.headers['set-cookie']))![1]!,
      csrf: login.json().csrf as string,
    };
    const o = (await kit.call({ method: 'POST', url: '/api/auth/stepup/passkey/options', ...a })).json();
    const r = await kit.call({
      method: 'POST',
      url: '/api/auth/stepup/passkey/verify',
      ...b,
      payload: {
        challengeId: o.challengeId,
        response: { id: 'key-1', challenge: kit.challengeOf(o.challengeId) },
      },
    });
    expect(r.statusCode).toBe(401);
  });

  it('refuses to remove the last sign-in method', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    await kit.stepUp(s);
    const r = await kit.call({ method: 'DELETE', url: '/api/security/passkeys/key-1', ...s });
    expect(r.statusCode).toBe(409);
  });

  it('logout-all revokes every session once fresh', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    await kit.stepUp(s);
    expect((await kit.call({ method: 'POST', url: '/api/auth/logout-all', ...s })).statusCode).toBe(200);
    expect((await kit.call({ method: 'GET', url: '/api/me', ...s })).statusCode).toBe(401);
  });
});

describe('password and one-time code', () => {
  async function withFallback() {
    kit = await makeKit();
    const s = await kit.signIn();
    await kit.stepUp(s);
    const set = (
      await kit.call({
        method: 'POST',
        url: '/api/security/fallback',
        ...s,
        payload: { password: 'correct horse battery' },
      })
    ).json();
    expect(set.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const bad = await kit.call({
      method: 'POST',
      url: '/api/security/fallback/confirm',
      ...s,
      payload: { code: '000000' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await kit.call({
      method: 'POST',
      url: '/api/security/fallback/confirm',
      ...s,
      payload: { code: kit.auth.currentTotpForTest(0, true) },
    });
    expect(ok.statusCode).toBe(200);
    kit.clock.advance(60_000);
    return s;
  }

  it('signs in with password then code, and a code works only once', async () => {
    await withFallback();
    const login = () =>
      kit.call({ method: 'POST', url: '/api/auth/password', payload: { password: 'correct horse battery' } });
    const p = (await login()).json();
    expect(p.pendingId).toBeTruthy();
    const code = kit.auth.currentTotpForTest();
    const ok = await kit.call({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { pendingId: p.pendingId, code },
    });
    expect(ok.statusCode).toBe(200);
    const p2 = (await login()).json();
    const replay = await kit.call({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { pendingId: p2.pendingId, code },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('accepts the code from another address, as on a mobile network whose exit address changes', async () => {
    await withFallback();
    const p = (
      await kit.call({
        method: 'POST',
        url: '/api/auth/password',
        remoteAddress: '203.0.113.83',
        payload: { password: 'correct horse battery' },
      })
    ).json();
    const ok = await kit.call({
      method: 'POST',
      url: '/api/auth/totp',
      remoteAddress: '203.0.113.84',
      payload: { pendingId: p.pendingId, code: kit.auth.currentTotpForTest() },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects a wrong password and a wrong code', async () => {
    await withFallback();
    const wrong = await kit.call({
      method: 'POST',
      url: '/api/auth/password',
      payload: { password: 'wrong wrong wrong' },
    });
    expect(wrong.statusCode).toBe(401);
    const p = (
      await kit.call({
        method: 'POST',
        url: '/api/auth/password',
        payload: { password: 'correct horse battery' },
      })
    ).json();
    const badCode = await kit.call({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { pendingId: p.pendingId, code: '123456' },
    });
    expect(badCode.statusCode).toBe(401);
  });

  it('keeps the old fallback working until a new one is confirmed', async () => {
    const s = await withFallback();
    await kit.stepUp(s);
    await kit.call({
      method: 'POST',
      url: '/api/security/fallback',
      ...s,
      payload: { password: 'another long passphrase' },
    });
    const old = await kit.call({
      method: 'POST',
      url: '/api/auth/password',
      payload: { password: 'correct horse battery' },
    });
    expect(old.statusCode).toBe(200);
    const fresh = await kit.call({
      method: 'POST',
      url: '/api/auth/password',
      payload: { password: 'another long passphrase' },
    });
    expect(fresh.statusCode).toBe(401);
  });

  it('allows only three code guesses per password step', async () => {
    await withFallback();
    const p = (
      await kit.call({
        method: 'POST',
        url: '/api/auth/password',
        payload: { password: 'correct horse battery' },
      })
    ).json();
    for (let i = 0; i < 3; i++)
      await kit.call({
        method: 'POST',
        url: '/api/auth/totp',
        payload: { pendingId: p.pendingId, code: '111111' },
      });
    kit.clock.advance(30_000);
    const late = await kit.call({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { pendingId: p.pendingId, code: kit.auth.currentTotpForTest() },
    });
    expect(late.statusCode).toBe(401);
  });

  it('stores the TOTP secret encrypted and the password hashed', async () => {
    await withFallback();
    const row = kit.auth.db.prepare('SELECT * FROM fallback').get() as {
      password_hash: string;
      totp_secret_enc: string;
    };
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.totp_secret_enc).not.toMatch(/^[A-Z2-7]{32}$/);
  });

  it('step-up works with a code', async () => {
    const s = await withFallback();
    const res = await kit.call({
      method: 'POST',
      url: '/api/auth/stepup/totp',
      ...s,
      payload: { code: kit.auth.currentTotpForTest() },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('websocket tickets', () => {
  it('are single use and expire after 30 seconds', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    const t1 = (await kit.call({ method: 'POST', url: '/api/ws-ticket', ...s })).json().ticket;
    expect(kit.auth.consumeTicket(t1)).toBeTruthy();
    expect(kit.auth.consumeTicket(t1)).toBeUndefined();
    const t2 = (await kit.call({ method: 'POST', url: '/api/ws-ticket', ...s })).json().ticket;
    kit.clock.advance(30_001);
    expect(kit.auth.consumeTicket(t2)).toBeUndefined();
  });

  it('die with the session', async () => {
    kit = await makeKit();
    const s = await kit.signIn();
    const t = (await kit.call({ method: 'POST', url: '/api/ws-ticket', ...s })).json().ticket;
    await kit.call({ method: 'POST', url: '/api/auth/logout', ...s });
    expect(kit.auth.consumeTicket(t)).toBeUndefined();
  });
});

describe('audit log', () => {
  it('records sign-ins and failures and redacts secrets', async () => {
    kit = await makeKit();
    await kit.signIn();
    await passkeyLogin(kit);
    kit.auth.audit('test', '1.1.1.1', { password: 'hunter2', nested: { token: 'abc', fine: 1 } });
    const rows = kit.auth.recentAudit();
    expect(rows.some((r) => r.kind === 'signin')).toBe(true);
    const t = rows.find((r) => r.kind === 'test')!;
    expect(JSON.stringify(t.detail)).not.toContain('hunter2');
    expect(JSON.stringify(t.detail)).not.toContain('abc');
    expect(JSON.stringify(t.detail)).toContain('"fine":1');
  });
});
