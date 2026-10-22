import { afterEach, describe, expect, it } from 'vitest';
import { securityHeaders } from './app.js';
import { redact } from './util.js';
import { makeKit, type Kit } from './testkit.js';

let kit: Kit;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

describe('response headers', () => {
  it('sets the full set on every kind of response, including errors and 404s', async () => {
    kit = await makeKit();
    for (const url of ['/health', '/api/me', '/nope-not-here']) {
      const h = (await kit.call({ method: 'GET', url })).headers;
      expect(h['content-security-policy'], url).toContain("default-src 'self'");
      expect(h['x-content-type-options'], url).toBe('nosniff');
      expect(h['referrer-policy'], url).toBe('no-referrer');
      expect(h['permissions-policy'], url).toContain('camera=()');
      expect(h['x-frame-options'], url).toBe('DENY');
      expect(h['cross-origin-opener-policy'], url).toBe('same-origin');
    }
  });

  it('the CSP forbids inline script, inline style, framing and other origins', () => {
    const csp = securityHeaders('https://ants.example.com')['Content-Security-Policy']!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' wss://ants.example.com");
  });

  it('adds HSTS only for an https origin', () => {
    expect(securityHeaders('https://ants.example.com')['Strict-Transport-Security']).toMatch(/max-age=\d+/);
    expect(securityHeaders('http://localhost:3100')['Strict-Transport-Security']).toBeUndefined();
  });

  it('never caches API responses', async () => {
    kit = await makeKit();
    expect((await kit.call({ method: 'GET', url: '/health' })).headers['cache-control']).toBe('no-store');
    expect((await kit.call({ method: 'GET', url: '/api/me' })).headers['cache-control']).toBe('no-store');
  });
});

describe('cross-origin access', () => {
  it('answers no CORS headers, even to a preflight from another origin', async () => {
    kit = await makeKit();
    const r = await kit.app.inject({
      method: 'OPTIONS',
      url: '/api/sessions',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    expect(r.statusCode).not.toBe(200);
  });
});

describe('input limits', () => {
  it('refuses a request body over 64 KB', async () => {
    kit = await makeKit();
    const r = await kit.call({
      method: 'POST',
      url: '/api/auth/password',
      payload: { password: 'x'.repeat(70_000) },
    });
    expect(r.statusCode).toBe(413);
    expect(r.body).not.toMatch(/stack|node_modules/i);
  });

  it('rejects a body that is not JSON', async () => {
    kit = await makeKit();
    const r = await kit.call({
      method: 'POST',
      url: '/api/auth/password',
      payload: 'password=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });

  it('rejects wrong types and oversize strings in login bodies', async () => {
    kit = await makeKit();
    for (const payload of [{ password: 5 }, { password: 'x'.repeat(300) }, [], 'x', null]) {
      const r = await kit.call({ method: 'POST', url: '/api/auth/password', payload: payload as never });
      expect(r.statusCode, JSON.stringify(payload).slice(0, 30)).toBeLessThan(500);
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('secrets in logs', () => {
  it('a failed login never writes the password, code or cookie into logs or the audit log', async () => {
    kit = await makeKit();
    await kit.call({ method: 'POST', url: '/api/auth/password', payload: { password: 'hunter2-hunter2' } });
    await kit.call({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { pendingId: 'p'.repeat(10), code: '654321' },
    });
    const all = JSON.stringify([kit.logs, kit.auth.recentAudit()]);
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('654321');
  });

  it('redact hides secret-looking keys at any depth and leaves the rest', () => {
    expect(
      redact({
        a: 1,
        password: 'x',
        nested: { apiKey: 'k', token: 't', ok: [{ secret: 's', fine: 2 }] },
        cookie: 'c',
        csrf: 'z',
      }),
    ).toEqual({
      a: 1,
      password: '[redacted]',
      nested: { apiKey: '[redacted]', token: '[redacted]', ok: [{ secret: '[redacted]', fine: 2 }] },
      cookie: '[redacted]',
      csrf: '[redacted]',
    });
  });

  it('log lines cannot be forged with line breaks (fail2ban safety)', async () => {
    kit = await makeKit();
    kit.auth.log('antlings-error x\nantlings-auth-fail ip=1.2.3.4 reason=forged');
    expect(kit.logs.at(-1)).not.toContain('\n');
  });
});

describe('startup refusals and the agent environment', () => {
  it('refuses to bind beyond loopback and http origins in production', async () => {
    const { loadConfig } = await import('./config.js');
    const base = { ANTLINGS_SECRET_KEY: Buffer.alloc(32, 7).toString('base64') };
    expect(() => loadConfig({ ...base, ANTLINGS_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', ANTLINGS_ORIGIN: 'http://ants.example.com' }),
    ).toThrow(/https/);
    expect(() => loadConfig({ ...base, ANTLINGS_AUTH_MODE: 'subscription' })).toThrow(
      /ANTLINGS_SUBSCRIPTION_OK/,
    );
    expect(() => loadConfig({ ANTLINGS_SECRET_KEY: 'short' })).toThrow(/32 bytes/);
  });

  it('the agent gets a small environment without the service secrets', async () => {
    const { sdkEnv } = await import('./agent.js');
    const { testConfig } = await import('./testkit.js');
    const env = sdkEnv(testConfig(), {
      PATH: '/usr/bin',
      HOME: '/home/antlings',
      ANTLINGS_SECRET_KEY: 'secret',
      ANTLINGS_VAPID_PRIVATE: 'priv',
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CODE_FOO: '1',
      SOME_OTHER: 'x',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.CLAUDE_CODE_FOO).toBe('1');
    expect(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe('3');
    expect(Object.keys(env).join()).not.toMatch(/ANTLINGS|SOME_OTHER/);
    const sub = sdkEnv(testConfig({ ANTLINGS_AUTH_MODE: 'subscription', ANTLINGS_SUBSCRIPTION_OK: '1' }), {
      ANTHROPIC_API_KEY: 'sk',
    });
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('the stored Claude mode and API key win over the environment', async () => {
    const { sdkEnv } = await import('./agent.js');
    const { testConfig } = await import('./testkit.js');
    const stored = sdkEnv(
      testConfig(),
      { ANTHROPIC_API_KEY: 'sk-ant-env' },
      { mode: 'apikey', apiKey: 'sk-ant-stored' },
    );
    expect(stored.ANTHROPIC_API_KEY).toBe('sk-ant-stored');
    const envOnly = sdkEnv(testConfig(), { ANTHROPIC_API_KEY: 'sk-ant-env' }, { mode: 'apikey' });
    expect(envOnly.ANTHROPIC_API_KEY).toBe('sk-ant-env');
    const sub = sdkEnv(testConfig(), { ANTHROPIC_API_KEY: 'sk-ant-env' }, { mode: 'subscription' });
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
