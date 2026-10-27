import { describe, expect, it } from 'vitest';
import { Scrollback } from './scrollback.js';

describe('Scrollback', () => {
  it('keeps exactly the newest 5,000 lines', () => {
    const s = new Scrollback();
    for (let i = 1; i <= 6000; i++) s.append(`line ${i}\n`);
    const lines = s.text().split('\n');
    expect(lines.filter((l) => l).length).toBe(5000);
    expect(lines[0]).toBe('line 1001');
    expect(lines.at(-2)).toBe('line 6000');
  });

  it('bounds one huge chunk without a newline and keeps its end', () => {
    const s = new Scrollback();
    s.append('a'.repeat(3 * 1024 * 1024) + 'END');
    expect(s.text().length).toBeLessThanOrEqual(1_048_576);
    expect(s.text().endsWith('aEND')).toBe(true);
  });

  it('stays fast and bounded under a flood once full', () => {
    const s = new Scrollback();
    const chunk = ('y'.repeat(79) + '\n').repeat(50);
    const t0 = Date.now();
    for (let i = 0; i < 20_000; i++) s.append(chunk);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s.text().length).toBeLessThanOrEqual(1_048_576);
    expect(s.text().split('\n').length - 1).toBeLessThanOrEqual(5000);
  });

  it('shrinks to the newest bytes', () => {
    const s = new Scrollback();
    s.append('a'.repeat(1000) + 'END');
    s.shrink(100);
    expect(s.text().length).toBe(100);
    expect(s.text().endsWith('aEND')).toBe(true);
  });

  it('joins a line split across chunks and is empty at the start', () => {
    const s = new Scrollback();
    expect(s.text()).toBe('');
    s.append('ab');
    s.append('c\nd');
    expect(s.text()).toBe('abc\nd');
  });
});
