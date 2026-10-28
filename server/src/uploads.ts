import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extensionOf,
  formatBytes,
  kindFromName,
  MAX_FILE_BYTES,
  sanitizeName,
  SESSION_QUOTA_BYTES,
  type AttachmentKind,
  type AttachmentRef,
} from '@antlings/shared';
import type { Db } from './db.js';
import { NotFoundError } from './sessions.js';
import type { Clock } from './util.js';

/** An attachment id that is unknown, belongs to another session, or has been purged. */
export class AttachmentNotFoundError extends NotFoundError {
  constructor() {
    super('An attached file is no longer on the server. Attach it again.');
  }
}

export class UploadError extends Error {
  constructor(
    readonly code: 'empty' | 'too_large' | 'bad_type' | 'quota',
    message: string,
  ) {
    super(message);
  }
}

export interface StoredUpload extends AttachmentRef {
  sessionId: string;
  mime: string;
  /** Absolute path of the stored file. */
  path: string;
  sent: boolean;
}

interface Row {
  id: string;
  session_id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  mime: string;
  file: string;
  created_at: number;
  sent: number;
}

const BAD_TYPE = 'This file type is not supported.';

const startsWith = (b: Buffer, bytes: number[], at = 0): boolean => bytes.every((v, i) => b[at + i] === v);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function imageType(b: Buffer): { mime: string; ext: string } | undefined {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mime: 'image/png', ext: 'png' };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')))
    return { mime: 'image/gif', ext: 'gif' };
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8))
    return { mime: 'image/webp', ext: 'webp' };
  return undefined;
}

function isText(b: Buffer): boolean {
  if (b.subarray(0, 8192).includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Uploaded files of all sessions: bytes on disk under `root/<sessionId>/`, details in the `uploads` table. */
export class Uploads {
  constructor(
    private readonly db: Db,
    private readonly root: string,
    private readonly clock: Clock,
    private readonly quotaBytes = SESSION_QUOTA_BYTES,
  ) {}

  /** The session's directory. It is created on first use and is the one directory the agent may read. */
  dirFor(sessionId: string): string {
    const dir = join(this.root, sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  save(sessionId: string, rawName: string, data: Buffer): StoredUpload {
    const name = sanitizeName(rawName);
    if (data.length === 0) throw new UploadError('empty', `${name} is empty.`);
    if (data.length > MAX_FILE_BYTES)
      throw new UploadError(
        'too_large',
        `${name} is ${formatBytes(data.length)}. The limit is 5 MB per file.`,
      );
    const byName = kindFromName(name);
    let kind: AttachmentKind;
    let mime: string;
    let ext: string;
    if (byName === 'image') {
      const t = imageType(data);
      if (!t) throw new UploadError('bad_type', BAD_TYPE);
      ({ mime, ext } = t);
      kind = 'image';
    } else if (byName === 'pdf') {
      if (!startsWith(data, ascii('%PDF-'))) throw new UploadError('bad_type', BAD_TYPE);
      [kind, mime, ext] = ['pdf', 'application/pdf', 'pdf'];
    } else if (byName === 'text') {
      if (!isText(data)) throw new UploadError('bad_type', BAD_TYPE);
      [kind, mime, ext] = ['text', 'text/plain; charset=utf-8', extensionOf(name)];
    } else throw new UploadError('bad_type', BAD_TYPE);

    const used = (
      this.db
        .prepare('SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE session_id = ?')
        .get(sessionId) as {
        n: number;
      }
    ).n;
    if (used + data.length > this.quotaBytes)
      throw new UploadError(
        'quota',
        'This session has reached its 200 MB upload limit. Start a new session.',
      );

    const id = randomUUID();
    const file = `${id}.${ext}`;
    writeFileSync(join(this.dirFor(sessionId), file), data, { mode: 0o600 });
    this.db
      .prepare(
        'INSERT INTO uploads (id, session_id, name, size, kind, mime, file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, sessionId, name, data.length, kind, mime, file, this.clock.now());
    return this.get(sessionId, id)!;
  }

  get(sessionId: string, id: string): StoredUpload | undefined {
    const r = this.db.prepare('SELECT * FROM uploads WHERE id = ? AND session_id = ?').get(id, sessionId) as
      Row | undefined;
    return r && this.toStored(r);
  }

  /** The uploads for these ids, in order. Throws if any is unknown or belongs to another session. */
  resolve(sessionId: string, ids: string[]): StoredUpload[] {
    return ids.map((id) => {
      const f = this.get(sessionId, id);
      if (!f) throw new AttachmentNotFoundError();
      return f;
    });
  }

  markSent(sessionId: string, ids: string[]): void {
    const st = this.db.prepare('UPDATE uploads SET sent = 1 WHERE id = ? AND session_id = ?');
    for (const id of ids) st.run(id, sessionId);
  }

  remove(sessionId: string, id: string): 'removed' | 'sent' | 'missing' {
    const f = this.get(sessionId, id);
    if (!f) return 'missing';
    if (f.sent) return 'sent';
    this.drop(f);
    return 'removed';
  }

  /** Deletes uploads that were never sent and are older than `maxAgeMs`. Returns how many. */
  purgeUnsent(maxAgeMs: number): number {
    const rows = this.db
      .prepare('SELECT * FROM uploads WHERE sent = 0 AND created_at < ?')
      .all(this.clock.now() - maxAgeMs) as Row[];
    for (const r of rows) this.drop(this.toStored(r));
    return rows.length;
  }

  removeSession(sessionId: string): void {
    rmSync(join(this.root, sessionId), { recursive: true, force: true });
    this.db.prepare('DELETE FROM uploads WHERE session_id = ?').run(sessionId);
  }

  private drop(f: StoredUpload): void {
    try {
      unlinkSync(f.path);
    } catch {
      /* already gone */
    }
    this.db.prepare('DELETE FROM uploads WHERE id = ?').run(f.id);
  }

  private toStored(r: Row): StoredUpload {
    return {
      id: r.id,
      sessionId: r.session_id,
      name: r.name,
      size: r.size,
      kind: r.kind,
      mime: r.mime,
      path: join(this.root, r.session_id, r.file),
      sent: r.sent === 1,
    };
  }
}
