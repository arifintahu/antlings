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
export const SETUP_CODE_MS = 15 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
const PENDING_MS = 5 * 60_000;
const TICKET_MS = 30_000;
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

  constructor(
    readonly db: Db,
    readonly clock: Clock,
    readonly config: Config,
    readonly webauthn: WebAuthnService,
    readonly log: (line: string) => void = (l) => console.error(l),
  ) {}

  // ---- audit and settings ----

  audit(kind: string, ip: string | undefined, detail?: unknown): void {
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

  /** Milliseconds left on a lockout for this address, or 0. */
  lockedFor(ip: string): number {
    const row = this.db.prepare('SELECT until FROM lockouts WHERE ip = ?').get(ip) as
      { until: number } | undefined;
    if (!row) return 0;
    const left = row.until - this.clock.now();
    if (left <= 0) {
      this.db.prepare('DELETE FROM lockouts WHERE ip = ?').run(ip);
      return 0;
    }
    return left;
  }

  recordFailure(ip: string, reason: string): void {
    const now = this.clock.now();
    this.db.prepare('INSERT INTO auth_failures (ip, at) VALUES (?, ?)').run(ip, now);
    this.db.prepare('DELETE FROM auth_failures WHERE at < ?').run(now - LOCKOUT_MS);
    this.log(`antlings-auth-fail ip=${ip} reason=${reason}`);
    this.audit('auth_failure', ip, { reason });
    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM auth_failures WHERE ip = ? AND at >= ?')
      .get(ip, now - LOCKOUT_MS) as { n: number };
    if (n >= MAX_FAILURES) {
      this.db
        .prepare(
          'INSERT INTO lockouts (ip, until) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET until = excluded.until',
        )
        .run(ip, now + LOCKOUT_MS);
      this.db.prepare('DELETE FROM auth_failures WHERE ip = ?').run(ip);
      this.log(`antlings-auth-lockout ip=${ip}`);
      this.audit('lockout', ip);
    }
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
      this.recordFailure(ip, 'totp');
      return null;
    }
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
  private checkTotp(code: string, includeUnconfirmed = false): boolean {
    const row = this.db.prepare('SELECT totp_secret_enc, confirmed FROM fallback').get() as
      { totp_secret_enc: string; confirmed: number } | undefined;
    if (!row || (!row.confirmed && !includeUnconfirmed)) return false;
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
  currentTotpForTest(offsetSteps = 0): string {
    const row = this.db.prepare('SELECT totp_secret_enc FROM fallback').get() as { totp_secret_enc: string };
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
    if (!cookie) return undefined;
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(cookie)) as
      SessionRow | undefined;
    if (!row || row.revoked_at !== null) return undefined;
    const now = this.clock.now();
    if (now - row.last_seen_at > this.idleMs()) {
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

  async setFallback(password: string): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = new OTP.Secret({ size: 20 });
    const hash = await argonHash(password);
    this.db
      .prepare(
        `INSERT INTO fallback (id, password_hash, totp_secret_enc, confirmed, created_at) VALUES (1, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, totp_secret_enc = excluded.totp_secret_enc, confirmed = 0`,
      )
      .run(hash, encrypt(this.config.secretKey, secret.base32), this.clock.now());
    return { secret: secret.base32, otpauthUrl: this.totpFor(secret.base32).toString() };
  }

  confirmFallback(code: string, ip: string): boolean {
    if (!this.checkTotp(code, true)) return false;
    this.db.prepare('UPDATE fallback SET confirmed = 1').run();
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
