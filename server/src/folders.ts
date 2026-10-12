import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export class FolderError extends Error {
  constructor(
    readonly code: 'bad_path' | 'not_found' | 'not_folder' | 'outside_home' | 'bad_name' | 'exists',
    message: string,
  ) {
    super(message);
  }
}

export interface FolderEntry {
  name: string;
}
export interface FolderListing {
  /** Path relative to the home folder, '/' separated. Empty means home itself. */
  path: string;
  parent: string | null;
  entries: FolderEntry[];
}

const MAX_PATH = 1024;
const MAX_SEGMENT = 255;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

/**
 * Folder access limited to the service user's home. Callers pass paths relative to home;
 * every path is resolved to its real location and must stay inside the real home.
 */
export class Folders {
  readonly home: string;

  constructor(home: string) {
    this.home = realpathSync(resolve(home));
  }

  private inside(real: string): boolean {
    const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const r = norm(real);
    const h = norm(this.home);
    return r === h || r.startsWith(h.endsWith(sep) ? h : h + sep);
  }

  /** Validates the text of a relative path before it touches the file system. */
  private segments(rel: string): string[] {
    if (typeof rel !== 'string' || rel.length > MAX_PATH)
      throw new FolderError('bad_path', 'Path is too long');
    if (rel === '') return [];
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
    if (/[\0\\:]/.test(rel) || /[\u0001-\u001f]/.test(rel) || isAbsolute(rel) || rel.startsWith('/')) {
      throw new FolderError('bad_path', 'Path is not allowed');
    }
    const parts = rel.split('/').filter((p) => p !== '');
    for (const p of parts) {
      if (p === '.' || p === '..' || p.length > MAX_SEGMENT)
        throw new FolderError('bad_path', 'Path is not allowed');
    }
    return parts;
  }

  /** Returns the real absolute path of a folder inside home. */
  resolve(rel: string): string {
    const abs = join(this.home, ...this.segments(rel));
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new FolderError('not_found', 'Folder not found');
    }
    if (!this.inside(real)) throw new FolderError('outside_home', 'Folder is outside the home folder');
    let st;
    try {
      st = statSync(real);
    } catch {
      throw new FolderError('not_found', 'Folder not found');
    }
    if (!st.isDirectory()) throw new FolderError('not_folder', 'That is a file, not a folder');
    return real;
  }

  /** Relative form of an absolute path, or null when it is outside home. */
  relative(abs: string): string | null {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return null;
    }
    if (!this.inside(real)) return null;
    return real.slice(this.home.length).split(sep).filter(Boolean).join('/');
  }

  list(rel: string): FolderListing {
    const real = this.resolve(rel);
    const entries: FolderEntry[] = [];
    for (const d of readdirSync(real, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      try {
        const child = join(real, d.name);
        // Symlinks are followed once and kept only if they land on a folder inside home.
        const target = d.isSymbolicLink() ? realpathSync(child) : child;
        if (!this.inside(target) || !statSync(target).isDirectory()) continue;
        entries.push({ name: d.name });
      } catch {
        /* unreadable or dangling: hide it */
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const path = this.relative(real) ?? '';
    const parent = path === '' ? null : path.split('/').slice(0, -1).join('/');
    return { path, parent, entries };
  }

  create(parentRel: string, name: string): string {
    const clean = name.trim();
    if (clean.length === 0 || clean.length > 100 || !NAME_RE.test(clean) || clean.includes('..')) {
      throw new FolderError('bad_name', 'Use letters, numbers, spaces, dots, dashes and underscores');
    }
    const parent = this.resolve(parentRel);
    const target = join(parent, clean);
    try {
      mkdirSync(target, { mode: 0o755 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new FolderError('exists', 'A folder with that name exists');
      throw new FolderError('bad_name', 'The folder could not be created');
    }
    return this.relative(target) ?? '';
  }
}
