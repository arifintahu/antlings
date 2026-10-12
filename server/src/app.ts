import cookie from '@fastify/cookie';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RouteOptions,
} from 'fastify';
import type { ZodType } from 'zod';
import {
  AddPasskeyVerifyBody,
  FallbackConfirmBody,
  FallbackSetBody,
  PasskeyLoginVerifyBody,
  PasswordLoginBody,
  SettingsBody,
  SetupOptionsBody,
  SetupVerifyBody,
  SignOutDeviceBody,
  StepUpPasskeyVerifyBody,
  StepUpTotpBody,
  TotpLoginBody,
} from '@antlings/shared';
import { Auth, MAX_SESSION_MS, type NewSession, type SessionRow } from './auth/service.js';
import { safeEqual } from './util.js';
import { registerStatic } from './static.js';

export const COOKIE_NAME = '__Host-antlings';
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' } as const;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    sess?: SessionRow;
    attemptId?: number;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
  interface FastifyInstance {
    auth: Auth;
    routeTable: RouteOptions[];
    requireFresh(req: FastifyRequest, reply: FastifyReply): boolean;
  }
}

export interface AppOptions {
  auth: Auth;
  /** Lets later modules (sessions, websocket) add routes before the app starts. */
  extend?: (app: FastifyInstance) => void | Promise<void>;
}

export function securityHeaders(origin: string): Record<string, string> {
  const ws = origin.replace(/^http/, 'ws');
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      `connect-src 'self' ${ws}`,
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    // Caddy also sets HSTS. Setting it here covers a direct hit on the service behind another proxy.
    ...(origin.startsWith('https:') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { auth } = opts;
  const { config } = auth;
  const app = Fastify({ trustProxy: '127.0.0.1', bodyLimit: 64 * 1024, logger: false });
  await app.register(cookie);
  app.decorate('auth', auth);
  const routeTable: RouteOptions[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    routeTable.push(r);
  });

  const headers = securityHeaders(config.origin);
  app.addHook('onSend', async (req, reply) => {
    if (req.attemptId !== undefined && reply.statusCode < 400) auth.releaseAttempt(req.attemptId);
    for (const [k, v] of Object.entries(headers)) reply.header(k, v);
    if (req.url.startsWith('/api/') || req.url === '/health') reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) auth.log(`antlings-error ${err.message.slice(0, 200)}`);
    return reply.code(status).send({ error: status === 500 ? 'internal_error' : 'bad_request' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

  // Origin check on every state-changing request, then session and CSRF checks on non-public routes.
  app.addHook('onRequest', async (req, reply) => {
    const unsafe = UNSAFE.has(req.method);
    if (unsafe && req.headers.origin !== config.origin) return reply.code(403).send({ error: 'bad_origin' });
    const isPublic = req.routeOptions?.config?.public === true;
    // Default deny: only routes marked public skip the session check. The URL string is never consulted.
    if (isPublic) return;
    const sess = auth.getSession(req.cookies[COOKIE_NAME]);
    if (!sess) return reply.code(401).send({ error: 'unauthorized' });
    if (unsafe && !safeEqual(String(req.headers['x-csrf-token'] ?? ''), sess.csrf))
      return reply.code(403).send({ error: 'bad_csrf' });
    req.sess = sess;
  });

  app.decorate('requireFresh', (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.sess && auth.isFresh(req.sess)) return true;
    reply.code(403).send({ error: 'stepup_required' });
    return false;
  });

  const pub = { config: { public: true } };
  const locked = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const ms = auth.lockedFor(req.ip);
    if (ms <= 0) {
      // Count the attempt now; a successful reply gives it back (see the onSend hook).
      req.attemptId = auth.reserveAttempt(req.ip);
      return false;
    }
    reply
      .header('Retry-After', String(Math.ceil(ms / 1000)))
      .code(429)
      .send({ error: 'locked', retryAfterMs: ms });
    return true;
  };
  const body = <T>(schema: ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | undefined => {
    const r = schema.safeParse(req.body);
    if (r.success) return r.data;
    reply.code(400).send({ error: 'bad_request' });
    return undefined;
  };
  const startSession = (reply: FastifyReply, s: NewSession) => {
    reply.setCookie(COOKIE_NAME, s.cookie, {
      ...COOKIE_OPTS,
      maxAge: Math.floor(MAX_SESSION_MS / 1000),
    });
    return reply.send({ ok: true, csrf: s.csrf });
  };
  const ua = (req: FastifyRequest) => String(req.headers['user-agent'] ?? '');

  // ---- public routes ----

  app.get('/health', pub, async () => ({ ok: true }));

  app.get('/api/auth/status', pub, async () => ({
    firstRun: !auth.hasCredentials(),
    passkey: auth.passkeyCount() > 0,
    fallback: auth.fallbackConfirmed(),
  }));

  app.post('/api/setup/options', pub, async (req, reply) => {
    if (auth.hasCredentials()) return reply.code(404).send({ error: 'not_found' });
    if (locked(req, reply)) return;
    const b = body(SetupOptionsBody, req, reply);
    if (!b) return;
    if (!auth.setupCodeValid(b.code)) {
      auth.recordFailure(req.ip, 'setup-code');
      return reply.code(403).send({ error: 'bad_code' });
    }
    return auth.setupOptions(b.code);
  });

  app.post('/api/setup/verify', pub, async (req, reply) => {
    if (auth.hasCredentials()) return reply.code(404).send({ error: 'not_found' });
    if (locked(req, reply)) return;
    const b = body(
      SetupVerifyBody.extend({ challengeId: PasskeyLoginVerifyBody.shape.challengeId }),
      req,
      reply,
    );
    if (!b) return;
    const s = await auth.setupVerify(
      b.code,
      b.challengeId,
      b.response,
      b.name ?? 'First device',
      req.ip,
      ua(req),
    );
    if (!s) {
      auth.recordFailure(req.ip, 'setup-verify');
      return reply.code(403).send({ error: 'setup_failed' });
    }
    return startSession(reply, s);
  });

  app.post('/api/auth/passkey/options', pub, async (req, reply) => {
    if (locked(req, reply)) return;
    return auth.passkeyLoginOptions();
  });

  app.post('/api/auth/passkey/verify', pub, async (req, reply) => {
    if (locked(req, reply)) return;
    const b = body(PasskeyLoginVerifyBody, req, reply);
    if (!b) return;
    const s = await auth.passkeyLoginVerify(b.challengeId, b.response, req.ip, ua(req));
    if (!s) return reply.code(401).send({ error: 'invalid_credentials' });
    return startSession(reply, s);
  });

  app.post('/api/auth/password', pub, async (req, reply) => {
    if (locked(req, reply)) return;
    const b = body(PasswordLoginBody, req, reply);
    if (!b) return;
    const r = await auth.passwordLogin(b.password, req.ip);
    if (!r) return reply.code(401).send({ error: 'invalid_credentials' });
    return r;
  });

  app.post('/api/auth/totp', pub, async (req, reply) => {
    if (locked(req, reply)) return;
    const b = body(TotpLoginBody, req, reply);
    if (!b) return;
    const s = await auth.totpLogin(b.pendingId, b.code, req.ip, ua(req));
    if (!s) return reply.code(401).send({ error: 'invalid_credentials' });
    return startSession(reply, s);
  });

  // ---- signed-in routes ----

  app.get('/api/me', async (req) => {
    const s = req.sess!;
    return { csrf: s.csrf, sessionId: s.short_id, fresh: auth.isFresh(s), freshUntil: s.fresh_until };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    auth.revoke(req.sess!.short_id);
    auth.audit('signout', req.ip);
    reply.clearCookie(COOKIE_NAME, COOKIE_OPTS);
    return { ok: true };
  });

  app.post('/api/auth/logout-device', async (req, reply) => {
    const b = body(SignOutDeviceBody, req, reply);
    if (!b) return;
    const ok = auth.revoke(b.id);
    if (ok) auth.audit('signout_device', req.ip, { id: b.id });
    return { ok };
  });

  app.post('/api/auth/logout-all', async (req, reply) => {
    if (!app.requireFresh(req, reply)) return;
    const n = auth.revokeAll();
    auth.audit('signout_all', req.ip, { count: n });
    reply.clearCookie(COOKIE_NAME, COOKIE_OPTS);
    return { ok: true, revoked: n };
  });

  app.post('/api/auth/stepup/passkey/options', async (req, reply) => {
    if (locked(req, reply)) return;
    return auth.stepUpPasskeyOptions(req.sess!);
  });

  app.post('/api/auth/stepup/passkey/verify', async (req, reply) => {
    if (locked(req, reply)) return;
    const b = body(StepUpPasskeyVerifyBody, req, reply);
    if (!b) return;
    const ok = await auth.stepUpPasskeyVerify(req.sess!, b.challengeId, b.response, req.ip);
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });
    return { ok: true };
  });

  app.post('/api/auth/stepup/totp', async (req, reply) => {
    if (locked(req, reply)) return;
    const b = body(StepUpTotpBody, req, reply);
    if (!b) return;
    if (!auth.stepUpTotp(req.sess!, b.code, req.ip))
      return reply.code(401).send({ error: 'invalid_credentials' });
    return { ok: true };
  });

  app.get('/api/security', async (req) => {
    const cur = req.sess!.short_id;
    return {
      passkeys: auth.listPasskeys(),
      fallback: auth.fallbackConfirmed(),
      sessions: auth.listSessions().map((s) => ({
        id: s.short_id,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        userAgent: s.user_agent,
        ip: s.ip,
        method: s.method,
        current: s.short_id === cur,
      })),
      audit: auth.recentAudit(100),
      settings: {
        idleTimeoutHours: auth.idleMs() / 3_600_000,
        signinAlerts: auth.getSetting('signin_alerts') !== '0',
      },
    };
  });

  app.post('/api/security/passkeys/options', async (req, reply) => {
    if (!app.requireFresh(req, reply)) return;
    return auth.addPasskeyOptions(req.sess!);
  });

  app.post('/api/security/passkeys/verify', async (req, reply) => {
    if (!app.requireFresh(req, reply)) return;
    const b = body(AddPasskeyVerifyBody, req, reply);
    if (!b) return;
    const ok = await auth.addPasskeyVerify(
      req.sess!,
      b.challengeId,
      b.response,
      b.name ?? 'New device',
      req.ip,
    );
    if (!ok) return reply.code(400).send({ error: 'registration_failed' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/security/passkeys/:id', async (req, reply) => {
    if (!app.requireFresh(req, reply)) return;
    const r = auth.removePasskey(req.params.id, req.ip);
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (r === 'last_method') return reply.code(409).send({ error: 'last_method' });
    return { ok: true };
  });

  app.post('/api/security/fallback', async (req, reply) => {
    if (!app.requireFresh(req, reply)) return;
    const b = body(FallbackSetBody, req, reply);
    if (!b) return;
    return auth.setFallback(b.password, req.ip);
  });

  app.post('/api/security/fallback/confirm', async (req, reply) => {
    if (!app.requireFresh(req, reply) || locked(req, reply)) return;
    const b = body(FallbackConfirmBody, req, reply);
    if (!b) return;
    if (!auth.confirmFallback(b.code, req.ip)) {
      auth.recordFailure(req.ip, 'fallback-confirm');
      return reply.code(400).send({ error: 'bad_code' });
    }
    return { ok: true };
  });

  app.patch('/api/security/settings', async (req, reply) => {
    if (!app.requireFresh(req, reply)) return;
    const b = body(SettingsBody, req, reply);
    if (!b) return;
    if (b.idleTimeoutHours !== undefined) auth.setSetting('idle_hours', String(b.idleTimeoutHours));
    if (b.signinAlerts !== undefined) auth.setSetting('signin_alerts', b.signinAlerts ? '1' : '0');
    auth.audit('settings_changed', req.ip, b);
    return { ok: true };
  });

  app.post('/api/ws-ticket', async (req) => ({ ticket: auth.createTicket(req.sess!) }));

  await opts.extend?.(app);
  if (config.staticDir) await registerStatic(app, config.staticDir);
  return app;
}
