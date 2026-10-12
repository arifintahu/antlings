import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FolderError, Folders } from './folders.js';

let root: string;
let home: string;
let outside: string;
let f: Folders;

const dirLink = (target: string, link: string) =>
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'antlings-folders-'));
  home = join(root, 'home');
  outside = join(root, 'outside');
  mkdirSync(join(home, 'projects', 'alpha'), { recursive: true });
  mkdirSync(join(home, 'projects', 'beta'));
  mkdirSync(join(home, '.ssh'));
  mkdirSync(join(home, 'docs'));
  mkdirSync(outside);
  mkdirSync(join(outside, 'secret'));
  writeFileSync(join(home, 'notes.txt'), 'x');
  dirLink(outside, join(home, 'escape'));
  dirLink(join(home, 'projects'), join(home, 'inside-link'));
  f = new Folders(home);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof FolderError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

describe('listing', () => {
  it('lists folders only, hides dot-folders, sorts by name', () => {
    const l = f.list('');
    expect(l.path).toBe('');
    expect(l.parent).toBeNull();
    const names = l.entries.map((e) => e.name);
    expect(names).toContain('projects');
    expect(names).toContain('docs');
    expect(names).not.toContain('.ssh');
    expect(names).not.toContain('notes.txt');
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('lists a subfolder with its parent', () => {
    const l = f.list('projects');
    expect(l.entries.map((e) => e.name)).toEqual(['alpha', 'beta']);
    expect(l.parent).toBe('');
    expect(f.list('projects/alpha').parent).toBe('projects');
  });

  it('hides a symlink that leaves home but keeps one that stays inside', () => {
    const names = f.list('').entries.map((e) => e.name);
    expect(names).not.toContain('escape');
    expect(names).toContain('inside-link');
  });
});

describe('path checks', () => {
  it.each([
    ['..', 'bad_path'],
    ['../outside', 'bad_path'],
    ['projects/../../outside', 'bad_path'],
    ['projects/..', 'bad_path'],
    ['./projects', 'bad_path'],
    ['/etc', 'bad_path'],
    ['C:/Windows', 'bad_path'],
    ['projects\\alpha', 'bad_path'],
    ['projects\0alpha', 'bad_path'],
    ['a'.repeat(300), 'bad_path'],
    [`${'projects/'.repeat(200)}x`, 'bad_path'],
  ])('rejects %j', (path, expected) => {
    expect(code(() => f.list(path))).toBe(expected);
  });

  it('treats an encoded traversal as a literal name that does not exist', () => {
    expect(code(() => f.list('%2e%2e'))).toBe('not_found');
    expect(code(() => f.list('%252e%252e/outside'))).toBe('not_found');
    expect(code(() => f.list('..%2foutside'))).toBe('not_found');
  });

  it('rejects a symlink that leaves home, listed or opened by name', () => {
    expect(code(() => f.list('escape'))).toBe('outside_home');
    expect(code(() => f.list('escape/secret'))).toBe('outside_home');
    expect(code(() => f.resolve('escape'))).toBe('outside_home');
  });

  it('accepts a symlink that stays inside home and returns the real path', () => {
    expect(f.resolve('inside-link/alpha')).toBe(join(f.home, 'projects', 'alpha'));
  });

  it('reports a missing path and a file', () => {
    expect(code(() => f.list('nope'))).toBe('not_found');
    expect(code(() => f.list('notes.txt'))).toBe('not_folder');
  });

  it('allows dot-folders by name only when asked explicitly inside home (they stay hidden in lists)', () => {
    expect(f.resolve('.ssh')).toBe(join(f.home, '.ssh'));
  });

  it('maps absolute paths back to relative ones and refuses outside paths', () => {
    expect(f.relative(join(f.home, 'projects', 'alpha'))).toBe('projects/alpha');
    expect(f.relative(f.home)).toBe('');
    expect(f.relative(outside)).toBeNull();
    expect(f.relative(join(f.home, 'escape', 'secret'))).toBeNull();
  });
});

describe('creating folders', () => {
  it('creates a folder and returns its relative path', () => {
    expect(f.create('projects', 'gamma')).toBe('projects/gamma');
    expect(f.list('projects').entries.map((e) => e.name)).toContain('gamma');
  });

  it('allows spaces, dots, dashes, underscores and unicode letters', () => {
    expect(f.create('', 'my app v1.2_x-y')).toBe('my app v1.2_x-y');
    expect(f.create('', 'café')).toBe('café');
  });

  it.each([
    '',
    '   ',
    '..',
    '.hidden',
    'a/b',
    'a\\b',
    'a\0b',
    '../x',
    'x..y',
    'x'.repeat(101),
    'bad:name',
    '-start',
    '~x',
    'a\nb',
  ])('rejects the name %j', (name) => {
    expect(code(() => f.create('', name))).toBe('bad_name');
  });

  it('refuses an existing name, a parent outside home and a missing parent', () => {
    expect(code(() => f.create('projects', 'alpha'))).toBe('exists');
    expect(code(() => f.create('escape', 'x'))).toBe('outside_home');
    expect(code(() => f.create('missing', 'x'))).toBe('not_found');
    expect(code(() => f.create('..', 'x'))).toBe('bad_path');
  });

  it('does not create anything through a symlink that leaves home', () => {
    code(() => f.create('escape', 'planted'));
    expect(existsSync(join(outside, 'planted'))).toBe(false);
  });
});
