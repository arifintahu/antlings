import { describe, expect, it } from 'vitest';
import { TERMINAL_ID_RE, TerminalClientMessage } from './terminal.js';

describe('TerminalClientMessage', () => {
  it('accepts input and a resize', () => {
    expect(TerminalClientMessage.safeParse({ t: 'in', d: 'ls\r' }).success).toBe(true);
    expect(TerminalClientMessage.safeParse({ t: 'resize', cols: 80, rows: 24 }).success).toBe(true);
  });

  it('refuses oversized input, bad sizes and unknown types', () => {
    const bad: unknown[] = [
      { t: 'in', d: 'x'.repeat(65_537) },
      { t: 'resize', cols: 0, rows: 24 },
      { t: 'resize', cols: 1e9, rows: 24 },
      { t: 'resize', cols: 'abc', rows: 24 },
      { t: 'nope' },
    ];
    for (const m of bad) expect(TerminalClientMessage.safeParse(m).success, JSON.stringify(m)).toBe(false);
  });
});

describe('TERMINAL_ID_RE', () => {
  it('takes 16 lowercase hex characters only', () => {
    expect(TERMINAL_ID_RE.test('0123456789abcdef')).toBe(true);
    expect(TERMINAL_ID_RE.test('../x')).toBe(false);
    expect(TERMINAL_ID_RE.test('0123456789ABCDEF')).toBe(false);
  });
});
