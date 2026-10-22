import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkAnthropicKey,
  claudeLoginSpec,
  claudeStatus,
  ghStatus,
  githubLoginSpec,
  runCli,
  type Cli,
} from './cli.js';

const fake: Cli = {
  cmd: process.execPath,
  args: [fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url))],
};
const env = (out: string, code = 0) => ({ PATH: process.env.PATH, FAKE_OUT: out, FAKE_CODE: String(code) });
const missing: Cli = { cmd: 'antlings-no-such-binary' };

describe('login spec parsers', () => {
  it('reads the GitHub device code and url', () => {
    const s = githubLoginSpec(fake, {});
    const text =
      '\n! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n';
    expect(s.parse(text)).toMatchObject({ code: 'AB12-CD34', url: 'https://github.com/login/device' });
    expect(s.urlHosts).toContain('github.com');
    expect(s.argv.slice(-6)).toEqual(['auth', 'login', '--web', '--git-protocol', 'https', '--skip-ssh-key']);
  });
  it('reads the Claude sign-in url and the code prompt', () => {
    const s = claudeLoginSpec(fake, {});
    const text =
      "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ";
    expect(s.parse(text)).toMatchObject({
      url: 'https://claude.com/cai/oauth/authorize?code=true&state=abc',
      needsCode: true,
    });
    expect(s.argv.slice(-3)).toEqual(['auth', 'login', '--claudeai']);
  });
  it('returns nothing for output it does not understand, and strips colour codes', () => {
    expect(githubLoginSpec(fake, {}).parse('hello world')).toEqual({});
    expect(claudeLoginSpec(fake, {}).parse('hello world')).toEqual({});
    const colored = '\u001b[1mOpen this URL: https://github.com/login/device\u001b[0m';
    expect(githubLoginSpec(fake, {}).parse(colored).url).toBe('https://github.com/login/device');
  });
});

describe('runCli', () => {
  it('captures output and the exit code', async () => {
    const r = await runCli(fake, [], { env: env('hi', 3), timeoutMs: 3000 });
    expect(r).toEqual({ code: 3, out: 'hi', missing: false });
  });
  it('reports a missing binary instead of throwing', async () => {
    const r = await runCli(missing, [], { env: {}, timeoutMs: 3000 });
    expect(r.missing).toBe(true);
  });
});

describe('status adapters', () => {
  it('ghStatus: signed in, signed out, missing', async () => {
    const ok = 'github.com\n  ✓ Logged in to github.com account octo (keyring)\n';
    expect(await ghStatus(fake, env(ok))).toEqual({ state: 'signed_in', login: 'octo' });
    expect(await ghStatus(fake, env('You are not logged into any GitHub hosts.', 1))).toEqual({
      state: 'signed_out',
    });
    expect(await ghStatus(missing, {})).toEqual({ state: 'unavailable' });
  });
  it('claudeStatus reads loggedIn, method and plan and never the email', async () => {
    const out = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      email: 'me@example.com',
    });
    const r = await claudeStatus(fake, env(out));
    expect(r).toEqual({ state: 'signed_in', method: 'claude.ai', plan: 'max' });
    expect(JSON.stringify(r)).not.toContain('example.com');
    expect(await claudeStatus(fake, env('{"loggedIn":false,"authMethod":"none"}'))).toEqual({
      state: 'signed_out',
    });
    expect(await claudeStatus(fake, env('not json'))).toEqual({ state: 'signed_out' });
    expect(await claudeStatus(missing, {})).toEqual({ state: 'unavailable' });
  });
});

describe('checkAnthropicKey', () => {
  const res = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
  it('maps 200 to ok, 401 and 403 to rejected, a network error to unreachable', async () => {
    expect(await checkAnthropicKey('sk-ant-x', res(200))).toBe('ok');
    expect(await checkAnthropicKey('sk-ant-x', res(401))).toBe('rejected');
    expect(await checkAnthropicKey('sk-ant-x', res(403))).toBe('rejected');
    expect(await checkAnthropicKey('sk-ant-x', res(500))).toBe('unreachable');
    const boom = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await checkAnthropicKey('sk-ant-x', boom)).toBe('unreachable');
  });
  it('sends the key as x-api-key to the models endpoint', async () => {
    let seen: { url: string; key: string | null } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, key: new Headers(init.headers).get('x-api-key') };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await checkAnthropicKey('sk-ant-abc', f);
    expect(seen).toEqual({ url: 'https://api.anthropic.com/v1/models', key: 'sk-ant-abc' });
  });
});
