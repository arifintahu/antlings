import type { TerminalServerMessage } from '@antlings/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakePtyFactory } from './fakePty.js';
import { ShellUnavailableError, TerminalLimitError, Terminals, type TerminalClient } from './registry.js';

let pty: FakePtyFactory;
let audit: [string, unknown][];
let terms: Terminals;
const size = { cols: 80, rows: 24 };

function client() {
  const got: TerminalServerMessage[] = [];
  const closed: string[] = [];
  const c: TerminalClient = { out: (m) => got.push(m), close: (why) => closed.push(why) };
  return { c, got, closed };
}

beforeEach(() => {
  pty = new FakePtyFactory();
  audit = [];
  terms = new Terminals({
    pty,
    clock: { now: () => 1000 },
    audit: (k, d) => audit.push([k, d]),
    env: { PATH: '/bin', HOME: '/home/a', ANTLINGS_SECRET_KEY: 'k', SHELL: '/bin/bash' },
  });
});

describe('create', () => {
  it('starts a login shell in the folder with the allowlisted env and audits it', () => {
    const t = terms.create('s1', '/work/proj', size);
    expect(t).toMatchObject({ running: true, exitCode: null, name: 'Shell 1', createdAt: 1000 });
    const o = pty.spawned[0]!.opts;
    expect(o).toMatchObject({ cwd: '/work/proj', cols: 80, rows: 24, args: ['-l'] });
    expect(o.env.ANTLINGS_SECRET_KEY).toBeUndefined();
    expect(o.env.PATH).toBe('/bin');
    expect(audit).toEqual([['terminal_opened', { sessionId: 's1', terminalId: t.id }]]);
  });

  it('numbers shells and never reuses a name', () => {
    const a = terms.create('s1', '/p', size);
    expect(terms.create('s1', '/p', size).name).toBe('Shell 2');
    terms.kill('s1', a.id);
    expect(terms.create('s1', '/p', size).name).toBe('Shell 3');
  });
});

describe('caps', () => {
  it('allows 4 running shells per session and 12 in total; exited ones do not count', () => {
    for (let i = 0; i < 4; i++) terms.create('s1', '/p', size);
    expect(() => terms.create('s1', '/p', size)).toThrow(TerminalLimitError);
    pty.spawned[0]!.exitWith(0);
    expect(() => terms.create('s1', '/p', size)).not.toThrow();
    for (const s of ['s2', 's3']) for (let i = 0; i < 4; i++) terms.create(s, '/p', size);
    expect(terms.runningCount()).toBe(12);
    expect(() => terms.create('s9', '/p', size)).toThrow(TerminalLimitError);
  });

  it('keeps at most 8 entries per session by dropping the oldest exited one', () => {
    let first = '';
    for (let i = 0; i < 8; i++) {
      const t = terms.create('s1', '/p', size);
      if (i === 0) first = t.id;
      pty.spawned[i]!.exitWith(0);
    }
    expect(terms.list('s1')).toHaveLength(8);
    terms.create('s1', '/p', size);
    const ids = terms.list('s1').map((t) => t.id);
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain(first);
  });

  it('turns a failing spawn into ShellUnavailableError and leaves no entry or audit row', () => {
    pty.failNext('secret path /x/y');
    expect(() => terms.create('s1', '/p', size)).toThrow(ShellUnavailableError);
    expect(terms.list('s1')).toEqual([]);
    expect(audit).toEqual([]);
  });
});

describe('attach', () => {
  it('replays earlier output once, then streams in order to every client', () => {
    const t = terms.create('s1', '/p', size);
    const p = pty.spawned[0]!;
    p.emit('before ');
    const a = client();
    terms.attach('s1', t.id, a.c);
    p.emit('after');
    const b = client();
    terms.attach('s1', t.id, b.c);
    p.emit('!');
    expect(a.got).toEqual([
      { t: 'replay', d: 'before ' },
      { t: 'out', d: 'after' },
      { t: 'out', d: '!' },
    ]);
    expect(b.got).toEqual([
      { t: 'replay', d: 'before after' },
      { t: 'out', d: '!' },
    ]);
  });

  it('stops delivery after detach and returns undefined for an unknown id', () => {
    const t = terms.create('s1', '/p', size);
    const a = client();
    const detach = terms.attach('s1', t.id, a.c)!;
    detach();
    pty.spawned[0]!.emit('x');
    expect(a.got).toEqual([{ t: 'replay', d: '' }]);
    expect(terms.attach('s1', 'ffffffffffffffff', a.c)).toBeUndefined();
    expect(terms.attach('other', t.id, a.c)).toBeUndefined();
  });
});

describe('write and resize', () => {
  it('reach the pty, clamp sizes, and refuse unknown or exited shells', () => {
    const t = terms.create('s1', '/p', size);
    const p = pty.spawned[0]!;
    expect(terms.write('s1', t.id, 'ls\r')).toBe(true);
    expect(p.written).toEqual(['ls\r']);
    expect(terms.resize('s1', t.id, 99999, 0)).toBe(true);
    expect(p.size).toEqual({ cols: 500, rows: 5 });
    expect(terms.write('s1', 'ffffffffffffffff', 'x')).toBe(false);
    expect(terms.resize('s1', 'ffffffffffffffff', 80, 24)).toBe(false);
    p.exitWith(0);
    expect(terms.write('s1', t.id, 'x')).toBe(false);
    expect(terms.resize('s1', t.id, 100, 30)).toBe(false);
    expect(p.written).toEqual(['ls\r']);
    expect(p.size).toEqual({ cols: 500, rows: 5 });
  });
});

describe('exit', () => {
  it('marks the shell exited, tells clients, keeps the scrollback and audits once', () => {
    const t = terms.create('s1', '/p', size);
    const p = pty.spawned[0]!;
    const a = client();
    terms.attach('s1', t.id, a.c);
    p.emit('bye');
    p.exitWith(3);
    expect(a.got.at(-1)).toEqual({ t: 'exit', code: 3 });
    expect(a.closed).toEqual(['exited']);
    expect(terms.list('s1')[0]).toMatchObject({ running: false, exitCode: 3 });
    const late = client();
    terms.attach('s1', t.id, late.c);
    expect(late.got).toEqual([
      { t: 'replay', d: 'bye' },
      { t: 'exit', code: 3 },
    ]);
    expect(late.closed).toEqual(['exited']);
    expect(terms.kill('s1', t.id)).toBe(true);
    expect(terms.list('s1')).toEqual([]);
    expect(p.killed).toBe(false);
    expect(audit.filter(([k]) => k === 'terminal_closed')).toEqual([
      ['terminal_closed', { sessionId: 's1', terminalId: t.id, reason: 'exited' }],
    ]);
  });
});

describe('kill', () => {
  it('kills the pty, closes clients, removes the entry and audits the reason', () => {
    const t = terms.create('s1', '/p', size);
    const p = pty.spawned[0]!;
    const a = client();
    terms.attach('s1', t.id, a.c);
    expect(terms.kill('s1', t.id, 'user')).toBe(true);
    expect(p.killed).toBe(true);
    expect(a.closed).toEqual(['killed']);
    expect(terms.list('s1')).toEqual([]);
    p.exitWith(1);
    expect(audit.filter(([k]) => k === 'terminal_closed')).toEqual([
      ['terminal_closed', { sessionId: 's1', terminalId: t.id, reason: 'user' }],
    ]);
    expect(terms.kill('s1', t.id)).toBe(false);
  });

  it('killSession leaves other sessions alone and killAll empties everything', () => {
    terms.create('s1', '/p', size);
    terms.create('s1', '/p', size);
    terms.create('s2', '/p', size);
    expect(terms.killSession('s1', 'archive')).toBe(2);
    expect(terms.list('s1')).toEqual([]);
    expect(terms.list('s2')).toHaveLength(1);
    terms.killAll();
    expect(terms.runningCount()).toBe(0);
    expect(pty.spawned.every((p) => p.killed)).toBe(true);
  });
});
