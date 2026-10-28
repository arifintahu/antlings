import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '@antlings/shared';
import { openDb } from './db.js';
import { NotFoundError } from './sessions.js';
import { FakeClock } from './testkit.js';
import { UploadError, Uploads } from './uploads.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from('GIF89a......');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n%%EOF');
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

let clock: FakeClock;
let root: string;
let up: Uploads;
const rows = (up2 = up) => (up2 as unknown as { db: ReturnType<typeof openDb> }).db;
beforeEach(() => {
  clock = new FakeClock();
  root = mkdtempSync(join(tmpdir(), 'antlings-uploads-'));
  up = new Uploads(openDb(':memory:'), root, clock);
});

const fail = (fn: () => unknown): UploadError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UploadError);
    return e as UploadError;
  }
  throw new Error('did not throw');
};

describe('save', () => {
  it('saves a png inside the session directory under a generated name', () => {
    const m = up.save(S1, 'shot.png', PNG);
    expect(m).toMatchObject({
      name: 'shot.png',
      size: PNG.length,
      kind: 'image',
      mime: 'image/png',
      sent: false,
    });
    expect(existsSync(m.path)).toBe(true);
    expect(dirname(m.path)).toBe(join(root, S1));
    expect(basename(m.path)).toMatch(/^[0-9a-f-]{36}\.png$/);
  });

  it('accepts jpeg, gif, webp and pdf by magic bytes', () => {
    expect(up.save(S1, 'a.jpg', JPEG)).toMatchObject({ kind: 'image', mime: 'image/jpeg' });
    expect(up.save(S1, 'a.gif', GIF)).toMatchObject({ kind: 'image', mime: 'image/gif' });
    expect(up.save(S1, 'a.webp', WEBP)).toMatchObject({ kind: 'image', mime: 'image/webp' });
    expect(up.save(S1, 'a.pdf', PDF)).toMatchObject({ kind: 'pdf', mime: 'application/pdf' });
  });

  it('accepts exactly 5 MB, rejects one byte more, and checks size before type', () => {
    expect(up.save(S1, 'ok.txt', Buffer.alloc(MAX_FILE_BYTES, 'a')).size).toBe(MAX_FILE_BYTES);
    expect(fail(() => up.save(S1, 'big.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 'a'))).code).toBe('too_large');
    const e = fail(() => up.save(S1, 'big.txt', Buffer.alloc(8 * 1024 * 1024, 'a')));
    expect(e.message).toBe('big.txt is 8 MB. The limit is 5 MB per file.');
    expect(fail(() => up.save(S1, 'dump.sqlite', Buffer.alloc(8 * 1024 * 1024))).code).toBe('too_large');
  });

  it('rejects an empty file', () => {
    const e = fail(() => up.save(S1, 'x.txt', Buffer.alloc(0)));
    expect(e.code).toBe('empty');
    expect(e.message).toBe('x.txt is empty.');
  });

  it('rejects by content, not only by extension', () => {
    const msg = 'This file type is not supported.';
    expect(fail(() => up.save(S1, 'run.exe', Buffer.from('MZ....'))).message).toBe(msg);
    expect(fail(() => up.save(S1, 'pic.svg', Buffer.from('<svg/>'))).code).toBe('bad_type');
    expect(fail(() => up.save(S1, 'pic.png', Buffer.from('just text'))).code).toBe('bad_type');
    expect(fail(() => up.save(S1, 'notes.txt', PNG)).code).toBe('bad_type');
    expect(fail(() => up.save(S1, 'notes.txt', Buffer.from([0xff, 0xfe, 0x41]))).code).toBe('bad_type');
  });

  it('never lets the original name reach the path', () => {
    const m = up.save(S1, '../../etc/passwd.txt', Buffer.from('x'));
    expect(m.name).toBe('passwd.txt');
    expect(relative(root, m.path).startsWith('..')).toBe(false);
    const a = up.save(S1, 'same.txt', Buffer.from('a'));
    const b = up.save(S1, 'same.txt', Buffer.from('b'));
    expect(a.path).not.toBe(b.path);
  });

  it('counts every stored file against the session quota', () => {
    const small = new Uploads(openDb(':memory:'), root, clock, 10);
    small.save(S1, 'a.txt', Buffer.from('123456'));
    const e = fail(() => small.save(S1, 'b.txt', Buffer.from('12345')));
    expect(e.code).toBe('quota');
    expect(e.message).toBe('This session has reached its 200 MB upload limit. Start a new session.');
    expect(small.save(S2, 'b.txt', Buffer.from('12345')).size).toBe(5);
  });
});

describe('lookup', () => {
  it('get and resolve are scoped to the session', () => {
    const m = up.save(S1, 'a.txt', Buffer.from('a'));
    expect(up.get(S1, m.id)?.id).toBe(m.id);
    expect(up.get(S2, m.id)).toBeUndefined();
    expect(up.resolve(S1, [m.id]).map((f) => f.id)).toEqual([m.id]);
    expect(() => up.resolve(S2, [m.id])).toThrow(NotFoundError);
    expect(() => up.resolve(S1, ['nope'])).toThrow(NotFoundError);
  });
});

describe('remove, purge and session delete', () => {
  it('removes an unsent upload, keeps a sent one', () => {
    const a = up.save(S1, 'a.txt', Buffer.from('a'));
    expect(up.remove(S1, a.id)).toBe('removed');
    expect(existsSync(a.path)).toBe(false);
    expect(up.get(S1, a.id)).toBeUndefined();
    const b = up.save(S1, 'b.txt', Buffer.from('b'));
    up.markSent(S1, [b.id]);
    expect(up.remove(S1, b.id)).toBe('sent');
    expect(existsSync(b.path)).toBe(true);
    expect(up.remove(S1, 'nope')).toBe('missing');
  });

  it('purges unsent uploads older than the age, keeps sent and fresh ones', () => {
    const old = up.save(S1, 'old.txt', Buffer.from('a'));
    const sent = up.save(S1, 'sent.txt', Buffer.from('b'));
    up.markSent(S1, [sent.id]);
    clock.advance(3_600_001);
    const fresh = up.save(S1, 'fresh.txt', Buffer.from('c'));
    expect(up.purgeUnsent(3_600_000)).toBe(1);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(sent.path)).toBe(true);
    expect(existsSync(fresh.path)).toBe(true);
  });

  it('removeSession deletes the directory and the rows', () => {
    const a = up.save(S1, 'a.txt', Buffer.from('a'));
    const other = up.save(S2, 'b.txt', Buffer.from('b'));
    up.removeSession(S1);
    expect(existsSync(join(root, S1))).toBe(false);
    expect(up.get(S1, a.id)).toBeUndefined();
    expect(readdirSync(join(root, S2))).toHaveLength(1);
    expect(up.get(S2, other.id)).toBeDefined();
    expect(rows().prepare('SELECT COUNT(*) AS n FROM uploads').get()).toEqual({ n: 1 });
  });

  it('dirFor creates the session directory', () => {
    expect(existsSync(up.dirFor(S1))).toBe(true);
  });
});
