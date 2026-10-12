import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, COOKIE_NAME, type AppOptions } from './app.js';
import { Auth } from './auth/service.js';
import type { StoredPasskey, WebAuthnService } from './auth/webauthn.js';
import { loadConfig, type Config } from './config.js';
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

export async function makeKit(
  over: Partial<AppOptions> = {},
  env: Record<string, string> = {},
): Promise<Kit> {
  const clock = new FakeClock();
  const logs: string[] = [];
  const config = testConfig(env);
  const auth = new Auth(openDb(':memory:'), clock, config, fakeWebAuthn, (l) => logs.push(l));
  const app = await buildApp({ auth, ...over });
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

  return { app, auth, clock, logs, signIn, challengeOf, stepUp, call };
}
