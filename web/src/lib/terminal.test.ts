import type { TerminalInfo } from '@antlings/shared';
import { describe, expect, it } from 'vitest';
import { chunkInput, ctrlOf, keyBytes, nextDelay, terminalLabel } from './terminal';

const info = (over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: '0123456789abcdef',
  name: 'Shell 1',
  running: true,
  exitCode: null,
  createdAt: 1,
  ...over,
});

describe('keyBytes', () => {
  it('maps the key bar to terminal bytes', () => {
    expect(keyBytes('esc')).toBe('\x1b');
    expect(keyBytes('tab')).toBe('\t');
    expect(keyBytes('up')).toBe('\x1b[A');
    expect(keyBytes('down')).toBe('\x1b[B');
    expect(keyBytes('left')).toBe('\x1b[D');
    expect(keyBytes('right')).toBe('\x1b[C');
    expect(keyBytes('ctrl-c')).toBe('\x03');
  });
});

describe('ctrlOf', () => {
  it('turns one letter or control symbol into its control character', () => {
    expect(ctrlOf('c')).toBe('\x03');
    expect(ctrlOf('C')).toBe('\x03');
    expect(ctrlOf('[')).toBe('\x1b');
    expect(ctrlOf('1')).toBe('1');
    expect(ctrlOf('ab')).toBe('ab');
    expect(ctrlOf('')).toBe('');
  });
});

describe('terminalLabel', () => {
  it('always says the state in words', () => {
    expect(terminalLabel(info(), 'open')).toBe('Running');
    expect(terminalLabel(info(), 'down')).toBe('Reconnecting…');
    expect(terminalLabel(info(), 'connecting')).toBe('Connecting…');
    expect(terminalLabel(info({ running: false, exitCode: 3 }), 'ended')).toBe('Exited (code 3)');
    expect(terminalLabel(info(), 'ended')).toBe('Ended');
  });
});

describe('chunkInput', () => {
  it('splits a big paste into frames under the server limit without cutting a surrogate pair', () => {
    const paste = 'x'.repeat(20_000) + '😀'.repeat(5000);
    const parts = chunkInput(paste, 8192);
    expect(parts.join('')).toBe(paste);
    expect(parts.every((p) => p.length <= 8192)).toBe(true);
    expect(parts.every((p) => !/[\ud800-\udbff]$/.test(p))).toBe(true);
    expect(chunkInput('ls', 8192)).toEqual(['ls']);
    expect(chunkInput('', 8192)).toEqual([]);
  });
});

describe('nextDelay', () => {
  it('backs off from 1 s to 15 s', () => {
    expect(nextDelay(0)).toBe(1000);
    expect(nextDelay(3)).toBe(8000);
    expect(nextDelay(10)).toBe(15000);
  });
});
