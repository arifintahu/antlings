import { existsSync } from 'node:fs';
import { ENV_ALLOW } from '../agent.js';

const REFUSED = new Set(['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false']);

/** `$SHELL` if it is an absolute path that exists and can log in, else bash, else sh; always a login shell so the profile sets PATH. */
export function pickShell(
  source: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync,
): { file: string; args: string[] } {
  const own = source.SHELL;
  const candidates = [own, '/bin/bash', '/bin/sh'].filter(
    (p): p is string => !!p && p.startsWith('/') && !REFUSED.has(p) && exists(p),
  );
  return { file: candidates[0] ?? '/bin/sh', args: ['-l'] };
}

/** The agent's allowlist plus colour support. Never `ANTLINGS_*` or the Anthropic key. */
export function terminalEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = source[k];
    if (v !== undefined) env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}
