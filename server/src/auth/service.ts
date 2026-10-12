import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';
import * as OTP from 'otpauth';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { decrypt, encrypt, randomToken, redact, sha256, type Clock } from '../util.js';
import type { StoredPasskey, WebAuthnService } from './webauthn.js';

export const FRESH_MS = 5 * 60_000;
export const LOCKOUT_MS = 15 * 60_000;
export const MAX_FAILURES = 5;
export const GLOBAL_MAX_FAILURES = 100;
export const SETUP_CODE_MS = 15 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
const PENDING_MS = 5 * 60_000;
const TICKET_MS = 30_000;
export const MAX_SESSION_MS = 30 * 86_400_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface SessionRow {
  id: string;
  short_id: string;
  csrf: string;
  created_at: number;
  last_seen_at: number;
  fresh_until: number;
  user_agent: string | null;
  ip: string | null;
  method: string;
  revoked_at: number | null;
}

export interface NewSession {
  cookie: string;
  csrf: string;
  shortId: string;
}

export class Auth {
  private dummyHash: Promise<string> | undefined;
  private pendingTries = new Map<string, number>();

  constructor(
    readonly db: Db,
    readonly clock: Clock,
    readonly config: Config,
    readonly webauthn: WebAuthnService,
    log: (line: string) => void = (l) => console.error(l),
  ) {
    // Strip control characters so nothing can forge a second log line for fail2ban.
    // eslint-disable-next-line no-control-regex
    this.log = (line) => log(line.replace(/[\x00-\x1f\x7f]+/g, ' '));
  }
  readonly log: (line: string) => void;

  // ---- audit and settings ----

  audit(kind: string, ip: string | undefined, detail?: unknown): void {
    this.db.prepare('DELETE FROM audit WHERE at < ?').run(this.clock.now() - 90 * 86_400_000);
    this.db
      .prepare('INSERT INTO audit (at, kind, ip, detail) VALUES (?, ?, ?, ?)')
      .run(this.clock.now(), kind, ip ?? null, detail === undefined ? null : JSON.stringify(redact(detail)));
  }

  recentAudit(limit = 100): { id: number; at: number; kind: string; ip: string | null; detail: unknown }[] {
    const rows = this.db
      .prepare('SELECT id, at, kind, ip, detail FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit) as {
      id: number;
      at: number;
      kind: string;
      ip: string | null;
      detail: string | null;
    }[];
    return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  getSetting(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    )?.value;
  }
  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
  idleMs(): number {
    return Number(this.getSetting('idle_hours') ?? this.config.idleHours) * 3_600_000;
  }

  // ---- rate limit ----

  /** Addresses are keyed per IPv4 address or per IPv6 /64, so rotating inside a /64 does not help. */
  static ipKey(ip: string): string {
    if (!ip.includes(':')) return ip;
    const [head = '', tail = ''] = ip.toLowerCase().split('::');
    const a = head ? head.split(':') : [];
    const b = tail ? tail.split(':') : [];
    const groups = ip.includes('::')
      ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b]
      : a;
    return (
      groups
        .slice(0, 4)
        .map((g) => g.padStart(4, '0'))
        .join(':') + '::/64'
    );
  }

  /** Milliseconds left on a lockout for this address, or 0. A global brake applies after many failures anywhere. */
  lockedFor(rawIp: string): number {
    const ip = Auth.ipKey(rawIp);
    const now = this.clock.now();
    const rows = this.db.prepare('SELECT until FROM lockouts WHERE ip IN (?, ?)').all(ip, '*') as {
      until: number;
    }[];
    const until = Math.max(0, ...rows.map((r) => r.until));
    if (until <= now) {
      this.db.prepare('DELETE FROM lockouts WHERE until <= ?').run(now);
      return 0;
    }
    return until - now;
  }

  /**
   * Counts an attempt before it is checked, so parallel requests cannot all pass a check that
   * only fails later. Call `releaseAttempt` when the attempt succeeds. Returns the row id.
   */
  reserveAttempt(rawIp: string): number {
    const ip = Auth.ipKey(rawIp);
    const now = this.clock.now();
    const id = Number(
      this.db.prepare('INSERT INTO auth_failures (ip, at) VALUES (?, ?)').run(ip, now).lastInsertRowid,
    );
    this.db.prepare('DELETE FROM auth_failures WHERE at < ?').run(now - LOCKOUT_MS);
    const lock = (key: string, why: string) => {
      this.db
        .prepare(
          'INSERT INTO lockouts (ip, until) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET until = excluded.until',
        )
        .run(key, now + LOCKOUT_MS);
      this.log(`antlings-auth-lockout ip=${rawIp} scope=${why}`);
      this.audit('lockout', rawIp, { scope: why });
    };
    const mine = (
      this.db.prepare('SELECT COUNT(*) AS n FROM auth_failures WHERE ip = ?').get(ip) as { n: number }
    ).n;
    if (mine >= MAX_FAILURES) {
      lock(ip, 'address');
      this.db.prepare('DELETE FROM auth_failures WHERE ip = ?').run(ip);
    }
    const all = (this.db.prepare('SELECT COUNT(*) AS n FROM auth_failures').get() as { n: number }).n;
    if (all >= GLOBAL_MAX_FAILURES) {
      lock('*', 'global');
      this.db.prepare('DELETE FROM auth_failures').run();
    }
    return id;
  }

  releaseAttempt(id: number): void {
    this.db.prepare('DELETE FROM auth_failures WHERE id = ?').run(id);
  }

  /** Writes the failure to the log fail2ban reads and to the audit log. The attempt was counted by `reserveAttempt`. */
  recordFailure(ip: string, reason: string): void {
    this.log(`antlings-auth-fail ip=${ip} reason=${reason}`);
    this.audit('auth_failure', ip, { reason });
  }

  // ---- credentials ----

  passkeyCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get() as { n: number }).n;
  }
  fallbackConfirmed(): boolean {
    return !!this.db.prepare('SELECT 1 FROM fallback WHERE confirmed = 1').get();
  }
  hasCredentials(): boolean {
    return this.passkeyCount() > 0 || this.fallbackConfirmed();
  }

  listPasskeys(): { id: string; name: string; createdAt: number; lastUsedAt: number | null }[] {
    return (
      this.db
        .prepare('SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at')
        .all() as {
        id: string;
        name: string;
        created_at: number;
        last_used_at: number | null;
      }[]
    ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  private lookupPasskey = (id: string): StoredPasskey | undefined => {
    const r = this.db
      .prepare('SELECT id, public_key, counter, transports FROM passkeys WHERE id = ?')
      .get(id) as { id: string; public_key: Buffer; counter: number; transports: string | null } | undefined;
    return (
      r && {
        id: r.id,
        publicKey: r.public_key,
        counter: r.counter,
        transports: r.transports ? JSON.parse(r.transports) : [],
      }
    );
  };

  private savePasskey(p: StoredPasskey, name: string): void {
    this.db
      .prepare(
        'INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(p.id, p.publicKey, p.counter, JSON.stringify(p.transports), name, this.clock.now());
  }

  // ---- challenges ----

  private putChallenge(kind: string, challenge: string, sessionId?: string, extra?: string): string {
    const id = randomToken(16);
    const now = this.clock.now();
    this.db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(now);
    this.db
      .prepare(
        'DELETE FROM challenges WHERE rowid IN (SELECT rowid FROM challenges ORDER BY expires_at DESC LIMIT -1 OFFSET 200)',
      )
      .run();
    this.db
      .prepare(
        'INSERT INTO challenges (id, kind, challenge, session_id, extra, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, kind, challenge, sessionId ?? null, extra ?? null, now + CHALLENGE_MS);
    return id;
  }

  /** Single use: the challenge is deleted when read. */
  private takeChallenge(
    id: string,
    kind: string,
    sessionId?: string,
  ): { challenge: string; extra: string | null } | undefined {
    const r = this.db.prepare('SELECT * FROM challenges WHERE id = ? AND kind = ?').get(id, kind) as
      { challenge: string; session_id: string | null; extra: string | null; expires_at: number } | undefined;
    this.db.prepare('DELETE FROM challenges WHERE id = ?').run(id);
    if (!r || r.expires_at < this.clock.now()) return undefined;
    if (sessionId !== undefined && r.session_id !== sessionId) return undefined;
    return { challenge: r.challenge, extra: r.extra };
  }

  // ---- setup (first run) ----

  createSetupCode(): { code: string; expiresAt: number } {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
    const now = this.clock.now();
    this.db.prepare('DELETE FROM setup_codes').run();
    this.db
      .prepare('INSERT INTO setup_codes (hash, expires_at) VALUES (?, ?)')
      .run(sha256(raw), now + SETUP_CODE_MS);
    return { code: `ANT-${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: now + SETUP_CODE_MS };
  }

  private static normalizeCode(code: string): string {
    return code
      .toUpperCase()
      .replace(/^ANT-?/, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  setupCodeValid(code: string): boolean {
    const r = this.db
      .prepare('SELECT expires_at, used_at FROM setup_codes WHERE hash = ?')
      .get(sha256(Auth.normalizeCode(code))) as { expires_at: number; used_at: number | null } | undefined;
    return !!r && r.used_at === null && r.expires_at > this.clock.now();
  }

  /** Removes passkeys, the fallback and every session, then returns a fresh setup code. */
  resetAccess(): { code: string; expiresAt: number } {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM passkeys').run();
      this.db.prepare('DELETE FROM fallback').run();
      this.db.prepare('DELETE FROM fallback_pending').run();
      this.db.prepare('DELETE FROM sessions').run();
      this.db.prepare('DELETE FROM ws_tickets').run();
      this.db.prepare('DELETE FROM pending_logins').run();
    })();
    this.audit('reset_access', undefined);
    return this.createSetupCode();
  }

  async setupOptions(code: string): Promise<{ challengeId: string; options: unknown }> {
    const { options, challenge } = await this.webauthn.registrationOptions([], 'owner');
    return {
      challengeId: this.putChallenge('setup', challenge, undefined, sha256(Auth.normalizeCode(code))),
      options,
    };
  }

  async setupVerify(
    code: string,
    challengeId: string,
    response: unknown,
    name: string,
    ip: string,
    ua: string,
  ): Promise<NewSession | null> {
    const ch = this.takeChallenge(challengeId, 'setup');
    const codeHash = sha256(Auth.normalizeCode(code));
    if (!ch || ch.extra !== codeHash || !this.setupCodeValid(code) || this.hasCredentials()) return null;
    const reg = await this.webauthn.verifyRegistration(response, ch.challenge);
    if (!reg) return null;
    return this.db.transaction(() => {
      // Re-check inside the transaction so two racing requests cannot both win.
      const used = this.db
        .prepare('UPDATE setup_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL')
        .run(this.clock.now(), codeHash);
      if (used.changes !== 1 || this.passkeyCount() > 0) return null;
      this.savePasskey(reg, name);
      this.audit('setup_complete', ip, { passkey: name });
      return this.createSession('passkey', ip, ua);
    })();
  }

  // ---- sign-in ----

  async passkeyLoginOptions(): Promise<{ challengeId: string; options: unknown }> {
    const { options, challenge } = await this.webauthn.authOptions();
    return { challengeId: this.putChallenge('login', challenge), options };
  }

  async passkeyLoginVerify(
    challengeId: string,
    response: unknown,
    ip: string,
    ua: string,
  ): Promise<NewSession | null> {
    const ch = this.takeChallenge(challengeId, 'login');
    const ok = ch ? await this.webauthn.verifyAuth(response, ch.challenge, this.lookupPasskey) : null;
    if (!ok) {
      this.recordFailure(ip, 'passkey');
      return null;
    }
    this.touchPasskey(ok.id, ok.newCounter);
    this.audit('signin', ip, { method: 'passkey' });
    return this.createSession('passkey', ip, ua);
  }

  private touchPasskey(id: string, counter: number): void {
    this.db
      .prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(counter, this.clock.now(), id);
  }

  private async verifyPassword(password: string): Promise<boolean> {
    const row = this.db.prepare('SELECT password_hash FROM fallback WHERE confirmed = 1').get() as
      { password_hash: string } | undefined;
    this.dummyHash ??= argonHash('antlings-dummy-password');
    const ok = await argonVerify(row?.password_hash ?? (await this.dummyHash), password).catch(() => false);
    return !!row && ok;
  }

  async passwordLogin(password: string, ip: string): Promise<{ pendingId: string } | null> {
    if (!(await this.verifyPassword(password))) {
      this.recordFailure(ip, 'password');
      return null;
    }
    const id = randomToken(16);
    this.db.prepare('DELETE FROM pending_logins WHERE expires_at < ?').run(this.clock.now());
    this.db
      .prepare('INSERT INTO pending_logins (id, ip, expires_at) VALUES (?, ?, ?)')
      .run(id, ip, this.clock.now() + PENDING_MS);
    return { pendingId: id };
  }

  async totpLogin(pendingId: string, code: string, ip: string, ua: string): Promise<NewSession | null> {
    const p = this.db.prepare('SELECT ip, expires_at FROM pending_logins WHERE id = ?').get(pendingId) as
      { ip: string; expires_at: number } | undefined;
    if (!p || p.expires_at < this.clock.now() || p.ip !== ip) {
      this.recordFailure(ip, 'pending');
      return null;
    }
    if (!this.checkTotp(code)) {
      const tries = (this.pendingTries.get(pendingId) ?? 0) + 1;
      this.pendingTries.set(pendingId, tries);
      if (tries >= 3) this.db.prepare('DELETE FROM pending_logins WHERE id = ?').run(pendingId);
      this.recordFailure(ip, 'totp');
      return null;
    }
    this.pendingTries.delete(pendingId);
    this.db.prepare('DELETE FROM pending_logins WHERE id = ?').run(pendingId);
    this.audit('signin', ip, { method: 'password+totp' });
    return this.createSession('password', ip, ua);
  }

  private totpFor(secretB32: string): OTP.TOTP {
    return new OTP.TOTP({
      issuer: 'Antlings',
      label: 'owner',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTP.Secret.fromBase32(secretB32),
    });
  }

  /** Accepts a code from the previous, current or next 30 s step. A step can be used once. */
  private checkTotp(code: string): boolean {
    const row = this.db.prepare('SELECT totp_secret_enc FROM fallback WHERE confirmed = 1').get() as
      { totp_secret_enc: string } | undefined;
    if (!row) return false;
    const now = this.clock.now();
    const delta = this.totpFor(decrypt(this.config.secretKey, row.totp_secret_enc)).validate({
      token: code,
      timestamp: now,
      window: 1,
    });
    if (delta === null) return false;
    const step = Math.floor(now / 30_000) + delta;
    if (step <= Number(this.getSetting('totp_last_step') ?? 0)) return false;
    this.setSetting('totp_last_step', String(step));
    return true;
  }

  /** Current code for the stored secret. Only tests call this. */
  currentTotpForTest(offsetSteps = 0, pending = false): string {
    const row = this.db
      .prepare(`SELECT totp_secret_enc FROM ${pending ? 'fallback_pending' : 'fallback'}`)
      .get() as {
      totp_secret_enc: string;
    };
    return this.totpFor(decrypt(this.config.secretKey, row.totp_secret_enc)).generate({
      timestamp: this.clock.now() + offsetSteps * 30_000,
    });
  }

  // ---- sessions ----

  createSession(method: string, ip: string, ua: string): NewSession {
    const cookie = randomToken(32);
    const csrf = randomToken(24);
    const shortId = randomToken(8);
    const now = this.clock.now();
    this.db
      .prepare(
        'INSERT INTO sessions (id, short_id, csrf, created_at, last_seen_at, user_agent, ip, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(sha256(cookie), shortId, csrf, now, now, ua.slice(0, 200), ip, method);
    return { cookie, csrf, shortId };
  }

  /** Returns the live session for a cookie value and refreshes its idle timer. */
  getSession(cookie: string | undefined): SessionRow | undefined {
    return cookie ? this.sessionById(sha256(cookie)) : undefined;
  }

  /** Same check by the stored id (used by open WebSocket connections). Revoked or idle sessions return undefined. */
  sessionById(id: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row || row.revoked_at !== null) return undefined;
    const now = this.clock.now();
    if (now - row.last_seen_at > this.idleMs() || now - row.created_at > MAX_SESSION_MS) {
      this.revoke(row.short_id);
      return undefined;
    }
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    return { ...row, last_seen_at: now };
  }

  listSessions(): Omit<SessionRow, 'id' | 'csrf'>[] {
    const now = this.clock.now();
    return (
      this.db
        .prepare('SELECT * FROM sessions WHERE revoked_at IS NULL ORDER BY created_at DESC')
        .all() as SessionRow[]
    )
      .filter((s) => now - s.last_seen_at <= this.idleMs())
      .map(({ id: _id, csrf: _csrf, ...rest }) => rest);
  }

  revoke(shortId: string): boolean {
    const r = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE short_id = ? AND revoked_at IS NULL')
      .run(this.clock.now(), shortId);
    return r.changes === 1;
  }

  revokeAll(): number {
    return this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL')
      .run(this.clock.now()).changes;
  }

  isFresh(s: SessionRow): boolean {
    return s.fresh_until > this.clock.now();
  }
  markFresh(s: SessionRow): void {
    this.db
      .prepare('UPDATE sessions SET fresh_until = ? WHERE id = ?')
      .run(this.clock.now() + FRESH_MS, s.id);
  }

  // ---- step-up ----

  async stepUpPasskeyOptions(s: SessionRow): Promise<{ challengeId: string; options: unknown }> {
    const { options, challenge } = await this.webauthn.authOptions();
    return { challengeId: this.putChallenge('stepup', challenge, s.id), options };
  }

  async stepUpPasskeyVerify(
    s: SessionRow,
    challengeId: string,
    response: unknown,
    ip: string,
  ): Promise<boolean> {
    const ch = this.takeChallenge(challengeId, 'stepup', s.id);
    const ok = ch ? await this.webauthn.verifyAuth(response, ch.challenge, this.lookupPasskey) : null;
    if (!ok) {
      this.recordFailure(ip, 'stepup-passkey');
      return false;
    }
    this.touchPasskey(ok.id, ok.newCounter);
    this.markFresh(s);
    this.audit('stepup', ip, { method: 'passkey' });
    return true;
  }

  stepUpTotp(s: SessionRow, code: string, ip: string): boolean {
    if (!this.checkTotp(code)) {
      this.recordFailure(ip, 'stepup-totp');
      return false;
    }
    this.markFresh(s);
    this.audit('stepup', ip, { method: 'totp' });
    return true;
  }

  // ---- security page actions ----

  async addPasskeyOptions(s: SessionRow): Promise<{ challengeId: string; options: unknown }> {
    const ids = this.listPasskeys().map((p) => p.id);
    const { options, challenge } = await this.webauthn.registrationOptions(ids, 'owner');
    return { challengeId: this.putChallenge('addkey', challenge, s.id), options };
  }

  async addPasskeyVerify(
    s: SessionRow,
    challengeId: string,
    response: unknown,
    name: string,
    ip: string,
  ): Promise<boolean> {
    const ch = this.takeChallenge(challengeId, 'addkey', s.id);
    const reg = ch ? await this.webauthn.verifyRegistration(response, ch.challenge) : null;
    if (!reg || this.lookupPasskey(reg.id)) return false;
    this.savePasskey(reg, name);
    this.audit('passkey_added', ip, { name });
    return true;
  }

  /** Refuses to remove the last way to sign in. */
  removePasskey(id: string, ip: string): 'ok' | 'last_method' | 'not_found' {
    if (!this.lookupPasskey(id)) return 'not_found';
    if (this.passkeyCount() <= 1 && !this.fallbackConfirmed()) return 'last_method';
    this.db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
    this.audit('passkey_removed', ip, { id });
    return 'ok';
  }

  /** Stores a new password and secret as pending. The working fallback stays active until the new code is confirmed. */
  async setFallback(password: string, ip?: string): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = new OTP.Secret({ size: 20 });
    const hash = await argonHash(password);
    this.db
      .prepare(
        `INSERT INTO fallback_pending (id, password_hash, totp_secret_enc, created_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, totp_secret_enc = excluded.totp_secret_enc, created_at = excluded.created_at`,
      )
      .run(hash, encrypt(this.config.secretKey, secret.base32), this.clock.now());
    this.audit('fallback_pending', ip);
    return { secret: secret.base32, otpauthUrl: this.totpFor(secret.base32).toString() };
  }

  /** Activates the pending fallback if the code matches its secret. */
  confirmFallback(code: string, ip: string): boolean {
    const p = this.db.prepare('SELECT password_hash, totp_secret_enc FROM fallback_pending').get() as
      { password_hash: string; totp_secret_enc: string } | undefined;
    if (!p) return false;
    const now = this.clock.now();
    const delta = this.totpFor(decrypt(this.config.secretKey, p.totp_secret_enc)).validate({
      token: code,
      timestamp: now,
      window: 1,
    });
    if (delta === null) return false;
    this.setSetting('totp_last_step', String(Math.floor(now / 30_000) + delta));
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO fallback (id, password_hash, totp_secret_enc, confirmed, created_at) VALUES (1, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, totp_secret_enc = excluded.totp_secret_enc, confirmed = 1`,
        )
        .run(p.password_hash, p.totp_secret_enc, now);
      this.db.prepare('DELETE FROM fallback_pending').run();
    })();
    this.audit('fallback_enabled', ip);
    return true;
  }

  // ---- websocket tickets ----

  createTicket(s: SessionRow): string {
    const t = randomToken(24);
    this.db.prepare('DELETE FROM ws_tickets WHERE expires_at < ?').run(this.clock.now());
    this.db
      .prepare('INSERT INTO ws_tickets (hash, session_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(t), s.id, this.clock.now() + TICKET_MS);
    return t;
  }

  /** Single use. Returns the session row only if the ticket is fresh and the session is still alive. */
  consumeTicket(ticket: string | undefined): SessionRow | undefined {
    if (!ticket) return undefined;
    const r = this.db
      .prepare(
        'UPDATE ws_tickets SET used = 1 WHERE hash = ? AND used = 0 AND expires_at > ? RETURNING session_id',
      )
      .get(sha256(ticket), this.clock.now()) as { session_id: string } | undefined;
    if (!r) return undefined;
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(r.session_id) as
      SessionRow | undefined;
    return s && s.revoked_at === null ? s : undefined;
  }
}
