import { spawn } from 'node:child_process';
import type { LoginSpec } from './runner.js';

/** A command plus fixed leading arguments, so tests and the browser tests can run `node fake.mjs` in place of `gh`. */
export interface Cli {
  cmd: string;
  args?: string[];
}

export type CliState = 'unavailable' | 'signed_out' | 'signed_in';

const OUTPUT_MAX = 64 * 1024;
const TEN_MINUTES = 10 * 60 * 1000;
// Matching the escape character is the point.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const clean = (text: string): string => text.replace(ANSI, '');

/** Runs a short command to the end. A missing binary is reported, not thrown. */
export function runCli(
  cli: Cli,
  args: string[],
  opts: { env: Record<string, string | undefined>; timeoutMs: number; input?: string },
): Promise<{ code: number | null; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    let out = '';
    let missing = false;
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: clean(out), missing });
    };
    const child = spawn(cli.cmd, [...(cli.args ?? []), ...args], {
      shell: false,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, opts.timeoutMs);
    const onData = (d: Buffer) => {
      if (out.length < OUTPUT_MAX) out += d.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => undefined);
    child.once('error', (e: NodeJS.ErrnoException) => {
      missing = e.code === 'ENOENT';
      done(null);
    });
    child.once('close', (code) => done(code));
    child.stdin.end(opts.input ?? '');
  });
}

export function githubLoginSpec(cli: Cli, env: Record<string, string | undefined>): LoginSpec {
  return {
    argv: [
      cli.cmd,
      ...(cli.args ?? []),
      'auth',
      'login',
      '--web',
      '--git-protocol',
      'https',
      '--skip-ssh-key',
    ],
    env,
    urlHosts: ['github.com'],
    parse(text) {
      const t = clean(text);
      return {
        code: /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(t)?.[1],
        url: /(https:\/\/github\.com\/login\/device)/.exec(t)?.[1],
      };
    },
    timeoutMs: TEN_MINUTES,
    noUrlMs: 15_000,
  };
}

export function claudeLoginSpec(cli: Cli, env: Record<string, string | undefined>): LoginSpec {
  return {
    argv: [cli.cmd, ...(cli.args ?? []), 'auth', 'login', '--claudeai'],
    env,
    urlHosts: ['claude.ai', 'claude.com', 'anthropic.com'],
    parse(text) {
      const t = clean(text);
      return {
        url: /visit:\s*(https:\/\/\S+)/.exec(t)?.[1],
        needsCode: /Paste code here/.test(t) || undefined,
      };
    },
    timeoutMs: TEN_MINUTES,
    noUrlMs: 15_000,
  };
}

export async function ghStatus(
  cli: Cli,
  env: Record<string, string | undefined>,
): Promise<{ state: CliState; login?: string }> {
  const r = await runCli(cli, ['auth', 'status'], { env, timeoutMs: 10_000 });
  if (r.missing) return { state: 'unavailable' };
  const login = /Logged in to github\.com account (\S+)/.exec(r.out)?.[1];
  return r.code === 0 && login ? { state: 'signed_in', login } : { state: 'signed_out' };
}

/** Reads `loggedIn`, `authMethod` and `subscriptionType` only. The account email in the same output is never kept. */
export async function claudeStatus(
  cli: Cli,
  env: Record<string, string | undefined>,
): Promise<{ state: CliState; method?: string; plan?: string }> {
  const r = await runCli(cli, ['auth', 'status', '--json'], { env, timeoutMs: 10_000 });
  if (r.missing) return { state: 'unavailable' };
  try {
    const j = JSON.parse(r.out) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
    if (j.loggedIn !== true) return { state: 'signed_out' };
    return {
      state: 'signed_in',
      ...(typeof j.authMethod === 'string' ? { method: j.authMethod } : {}),
      ...(typeof j.subscriptionType === 'string' ? { plan: j.subscriptionType } : {}),
    };
  } catch {
    return { state: 'signed_out' };
  }
}

/** Asks the models endpoint, which costs nothing, whether the key is accepted. */
export async function checkAnthropicKey(
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<'ok' | 'rejected' | 'unreachable'> {
  try {
    const res = await fetchFn('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return 'ok';
    return res.status === 401 || res.status === 403 ? 'rejected' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
