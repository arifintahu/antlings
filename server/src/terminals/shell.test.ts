import { describe, expect, it } from 'vitest';
import { pickShell, terminalEnv } from './shell.js';

describe('pickShell', () => {
  it('uses $SHELL as a login shell when it is absolute and exists', () => {
    expect(pickShell({ SHELL: '/bin/zsh' }, () => true)).toEqual({ file: '/bin/zsh', args: ['-l'] });
  });

  it('falls back to bash, then sh', () => {
    const all = () => true;
    for (const SHELL of [undefined, '/usr/sbin/nologin', '/bin/false', 'bash']) {
      expect(pickShell({ SHELL }, all).file, String(SHELL)).toBe('/bin/bash');
    }
    expect(pickShell({ SHELL: '/nope/zsh' }, (p) => p !== '/nope/zsh').file).toBe('/bin/bash');
    expect(pickShell({}, (p) => p === '/bin/sh')).toEqual({ file: '/bin/sh', args: ['-l'] });
  });
});

describe('terminalEnv', () => {
  it('passes the allowlist plus TERM and COLORTERM and nothing secret', () => {
    const env = terminalEnv({
      PATH: '/bin',
      HOME: '/home/a',
      ANTLINGS_SECRET_KEY: 'k',
      ANTHROPIC_API_KEY: 's',
      CLAUDE_X: '1',
    });
    expect(env).toMatchObject({
      PATH: '/bin',
      HOME: '/home/a',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
    expect(Object.keys(env).filter((k) => /ANTLINGS|ANTHROPIC|CLAUDE/.test(k))).toEqual([]);
    expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true);
  });
});
