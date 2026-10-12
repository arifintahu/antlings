import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, COOKIE_NAME, type AppOptions } from './app.js';
import { Auth } from './auth/service.js';
import type { StoredPasskey, WebAuthnService } from './auth/webauthn.js';
import { loadConfig, type Config } from './config.js';
import { FakeAgents, FakeTranscripts } from './fakeAgent.js';
import { SessionManager } from './sessions.js';
import { Folders } from './folders.js';
import webpush from 'web-push';
import { PushService } from './push.js';
import { wireApp } from './wiring.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { openDb } from './db.js';
import { randomToken, type Clock } from './util.js';

export const ORIGIN = 'http://localhost:3100';

export class FakeClock implements Clock {
  constructor(public t = 1_800_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Passkey ceremonies for tests: a response is valid when it echoes the challenge. */
export const fakeWebAuthn: WebAuthnService = {
  async registrationOptions() {
    return { options: {}, challenge: randomToken(12) };
  },
  async verifyRegistration(response, challenge) {
    const r = response as { id?: string; challenge?: string };
    if (!r.id || r.challenge !== challenge) return null;
    return { id: r.id, publicKey: Buffer.from('pk'), counter: 0, transports: [] };
  },
  async authOptions() {
    return { options: {}, challenge: randomToken(12) };
  },
  async verifyAuth(response, challenge, lookup: (id: string) => StoredPasskey | undefined) {
    const r = response as { id?: string; challenge?: string };
    if (!r.id || r.challenge !== challenge || !lookup(r.id)) return null;
    return { id: r.id, newCounter: 1 };
  },
};

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    ANTLINGS_ORIGIN: ORIGIN,
    ANTLINGS_SECRET_KEY: randomBytes(32).toString('base64'),
    ANTLINGS_DATA_DIR: './data-test',
    ...over,
  });
}

export interface Creds {
  cookie: string;
  csrf: string;
}

export interface Kit {
  app: FastifyInstance;
  mgr: SessionManager;
  push: PushService;
  /** Payloads handed to the web-push library, with the endpoint they went to. */
  pushSent: { endpoint: string; payload: Record<string, unknown> }[];
  pushFail: { status?: number };
  /** A real temporary home folder; Antlings may only touch folders inside it. */
  home: string;
  folders: Folders;
  agents: FakeAgents;
  transcripts: FakeTranscripts;
  /** Starts listening on a free port and returns an opener for authenticated WebSocket clients. */
  listen(): Promise<{
    port: number;
    open(c: Creds, opts?: { origin?: string | null; ticket?: string }): Promise<TestSocket>;
  }>;
  auth: Auth;
  clock: FakeClock;
  logs: string[];
  /** Registers the first passkey through the real setup endpoints and returns the cookie and CSRF token. */
  signIn(): Promise<Creds>;
  /** Echoes the stored challenge, which is what the fake authenticator needs. */
  challengeOf(id: string): string;
  /** Runs the step-up passkey ceremony so the session counts as fresh. */
  stepUp(c: Creds): Promise<void>;
  call(opts: InjectOptions & { cookie?: string; csrf?: string }): Promise<LightMyRequestResponse>;
}

export interface TestSocket {
  ws: WebSocket;
  received: { t: string; [k: string]: unknown }[];
  send(m: unknown): void;
  waitFor(
    pred: (m: { t: string; [k: string]: unknown }) => boolean,
    ms?: number,
  ): Promise<{ t: string; [k: string]: unknown }>;
  closed: Promise<number>;
}

export async function makeKit(
  over: Partial<AppOptions> = {},
  env: Record<string, string> = {},
): Promise<Kit> {
  const clock = new FakeClock();
  const logs: string[] = [];
  const homeDir = mkdtempSync(join(tmpdir(), 'antlings-home-'));
  mkdirSync(join(homeDir, 'proj'));
  const config = testConfig({ ANTLINGS_HOME: homeDir, ...env });
  const folders = new Folders(homeDir);
  const auth = new Auth(openDb(':memory:'), clock, config, fakeWebAuthn, (l) => logs.push(l));
  const agents = new FakeAgents();
  const transcripts = new FakeTranscripts();
  const pushSent: Kit['pushSent'] = [];
  const pushFail: Kit['pushFail'] = {};
  const push = new PushService(
    auth.db,
    clock,
    { ...webpush.generateVAPIDKeys(), subject: 'mailto:test@localhost' },
    (async (sub: { endpoint: string }, body: string) => {
      if (pushFail.status) throw Object.assign(new Error('gone'), { statusCode: pushFail.status });
      pushSent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
    }) as never,
  );
  const mgr = new SessionManager({
    db: auth.db,
    clock,
    config,
    agents,
    transcripts,
    audit: (kind, detail) => auth.audit(kind, undefined, detail),
    notifier: push,
  });
  const app = await buildApp({
    auth,
    extend: (a) => {
      wireApp(a, { auth, mgr, folders, transcripts, push });
      a.addHook('onClose', async () => rmSync(homeDir, { recursive: true, force: true }));
    },
    ...over,
  });
  await app.ready();

  const call: Kit['call'] = ({ cookie, csrf, headers, method, ...rest }) =>
    app.inject({
      method,
      ...rest,
      headers: {
        ...(method && method !== 'GET' ? { origin: ORIGIN } : {}),
        ...(cookie ? { cookie: `${COOKIE_NAME}=${cookie}` } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...headers,
      },
    });

  const challengeOf = (id: string): string =>
    auth.db.prepare('SELECT challenge FROM challenges WHERE id = ?').pluck().get(id) as string;

  const signIn: Kit['signIn'] = async () => {
    const { code } = auth.createSetupCode();
    const o = (await call({ method: 'POST', url: '/api/setup/options', payload: { code } })).json();
    const v = await call({
      method: 'POST',
      url: '/api/setup/verify',
      payload: {
        code,
        challengeId: o.challengeId,
        response: { id: 'key-1', challenge: challengeOf(o.challengeId) },
      },
    });
    if (v.statusCode !== 200) throw new Error(`setup failed: ${v.statusCode} ${v.body}`);
    const cookie = v.cookies.find((c) => c.name === COOKIE_NAME)!.value;
    // Tests start from an ordinary session; the first-run session is fresh for 5 minutes.
    clock.advance(5 * 60_000 + 1);
    return { cookie, csrf: v.json().csrf };
  };

  const stepUp: Kit['stepUp'] = async (c) => {
    const o = (await call({ method: 'POST', url: '/api/auth/stepup/passkey/options', ...c })).json();
    const r = await call({
      method: 'POST',
      url: '/api/auth/stepup/passkey/verify',
      ...c,
      payload: {
        challengeId: o.challengeId,
        response: { id: 'key-1', challenge: challengeOf(o.challengeId) },
      },
    });
    if (r.statusCode !== 200) throw new Error(`step-up failed: ${r.statusCode}`);
  };

  const listen: Kit['listen'] = async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    return {
      port,
      async open(c, o = {}) {
        let ticket = o.ticket;
        if (ticket === undefined)
          ticket = (await call({ method: 'POST', url: '/api/ws-ticket', ...c })).json().ticket;
        const headers: Record<string, string> = {};
        if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`, { headers });
        const received: TestSocket['received'] = [];
        const waiters: (() => void)[] = [];
        ws.on('message', (d) => {
          received.push(JSON.parse(d.toString()));
          waiters.forEach((w) => w());
        });
        const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
        await new Promise<void>((res, rej) => {
          ws.on('open', () => res());
          ws.on('error', rej);
          ws.on('unexpected-response', (_q, r) => rej(new Error(`status ${r.statusCode}`)));
        });
        return {
          ws,
          received,
          closed,
          send: (m) => ws.send(JSON.stringify(m)),
          waitFor: (pred, ms = 3000) =>
            new Promise((res, rej) => {
              const check = () => {
                const f = received.find(pred);
                if (f) res(f);
              };
              waiters.push(check);
              check();
              setTimeout(
                () => rej(new Error(`timeout; got ${JSON.stringify(received.slice(-5))}`)),
                ms,
              ).unref();
            }),
        };
      },
    };
  };

  return {
    app,
    mgr,
    push,
    pushSent,
    pushFail,
    home: folders.home,
    folders,
    agents,
    transcripts,
    listen,
    auth,
    clock,
    logs,
    signIn,
    challengeOf,
    stepUp,
    call,
  };
}
