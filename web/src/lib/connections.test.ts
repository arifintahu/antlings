import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectionTone,
  loginActive,
  setupLabel,
  pollWhile,
  stateLabel,
  type ConnectionsDto,
  type LoginState,
} from './connections.js';

afterEach(() => vi.useRealTimers());

describe('stateLabel', () => {
  const states: LoginState[] = [
    { phase: 'idle' },
    { phase: 'starting', expiresAt: 1 },
    { phase: 'waiting', url: 'https://github.com/login/device', code: 'AB12-CD34', expiresAt: 1 },
    { phase: 'waiting', url: 'https://claude.com/x', needsCode: true, expiresAt: 1 },
    { phase: 'done' },
    { phase: 'error', reason: 'no_url' },
    { phase: 'error', reason: 'timeout' },
    { phase: 'error', reason: 'failed' },
    { phase: 'error', reason: 'unavailable' },
    { phase: 'error', reason: 'cancelled' },
  ];

  it('gives every state its own text', () => {
    const labels = states.map((s) => stateLabel(s, 'github'));
    for (const l of labels) expect(l.length).toBeGreaterThan(3);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it('never puts the device code in the label', () => {
    expect(stateLabel(states[2]!, 'github')).not.toContain('AB12');
  });
  it('names the provider while waiting', () => {
    expect(stateLabel(states[2]!, 'github')).toContain('GitHub');
    expect(stateLabel({ phase: 'waiting', code: 'x', expiresAt: 1 }, 'claude')).toContain('Claude');
  });
  it('tells the owner what to do when no url appeared', () => {
    expect(stateLabel({ phase: 'error', reason: 'no_url' }, 'github')).toMatch(/command/i);
  });
});

describe('connectionTone and loginActive', () => {
  it('maps CLI state to a tone', () => {
    expect(connectionTone({ state: 'signed_in' })).toBe('ok');
    expect(connectionTone({ state: 'unavailable' })).toBe('warn');
    expect(connectionTone({ state: 'signed_out' })).toBe('idle');
  });
  it('treats only starting and waiting as active', () => {
    expect(loginActive({ phase: 'starting', expiresAt: 1 })).toBe(true);
    expect(loginActive({ phase: 'waiting', expiresAt: 1 })).toBe(true);
    for (const s of [
      { phase: 'idle' },
      { phase: 'done' },
      { phase: 'error', reason: 'failed' },
    ] as LoginState[])
      expect(loginActive(s)).toBe(false);
  });
});

describe('pollWhile', () => {
  const dto = (phase: 'waiting' | 'done'): ConnectionsDto =>
    ({
      github: { login: phase === 'done' ? { phase } : { phase, expiresAt: 1 } },
      claude: { login: { phase: 'idle' } },
    }) as ConnectionsDto;
  const active = (d: ConnectionsDto) => loginActive(d.github.login) || loginActive(d.claude.login);

  it('fetches every interval and stops itself when nothing is active', async () => {
    vi.useFakeTimers();
    const answers = [dto('waiting'), dto('waiting'), dto('done'), dto('done')];
    const fn = vi.fn(async () => answers.shift()!);
    const seen: string[] = [];
    pollWhile(fn, active, (d) => seen.push(d.github.login.phase), 1500);
    await vi.advanceTimersByTimeAsync(1500 * 6);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(['waiting', 'waiting', 'done']);
  });

  it('the returned function cancels the polling', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => dto('waiting'));
    const stop = pollWhile(fn, active, () => undefined, 1500);
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    await vi.advanceTimersByTimeAsync(1500 * 5);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after a failed request', async () => {
    vi.useFakeTimers();
    let n = 0;
    const fn = vi.fn(async () => {
      if (++n === 1) throw new Error('offline');
      return dto('done');
    });
    const seen: string[] = [];
    pollWhile(fn, active, (d) => seen.push(d.github.login.phase), 1500);
    await vi.advanceTimersByTimeAsync(1500 * 3);
    expect(seen).toEqual(['done']);
  });
});

describe('setupLabel', () => {
  it('is empty while unknown and when both are connected', () => {
    expect(setupLabel(null)).toBe('');
    expect(setupLabel({ claude: 'connected', github: 'connected' })).toBe('');
  });
  it('names exactly what is missing', () => {
    expect(setupLabel({ claude: 'missing', github: 'connected' })).toBe('Set up Claude');
    expect(setupLabel({ claude: 'connected', github: 'missing' })).toBe('Set up GitHub');
    expect(setupLabel({ claude: 'missing', github: 'missing' })).toBe('Set up Claude and GitHub');
  });
});
