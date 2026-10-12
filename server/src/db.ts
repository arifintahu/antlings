import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT,
  name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS fallback (
  id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL, totp_secret_enc TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fallback_pending (
  id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT NOT NULL, totp_secret_enc TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, short_id TEXT NOT NULL UNIQUE, csrf TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, fresh_until INTEGER NOT NULL DEFAULT 0, user_agent TEXT, ip TEXT,
  method TEXT NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS setup_codes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL, session_id TEXT, extra TEXT, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_logins (id TEXT PRIMARY KEY, ip TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ws_tickets (hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS auth_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_failures_ip ON auth_failures (ip, at);
CREATE TABLE IF NOT EXISTS lockouts (ip TEXT PRIMARY KEY, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, ip TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS event_log (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_meta (
  id TEXT PRIMARY KEY, cwd TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, mode TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  if (path !== ':memory:' && process.platform !== 'win32') {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        chmodSync(f, 0o600);
      } catch {
        /* the file may not exist yet */
      }
    }
  }
  return db;
}
