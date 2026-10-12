import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const Env = z.object({
  ANTLINGS_ORIGIN: z.string().url().default('http://localhost:3100'),
  ANTLINGS_HOST: z.string().default('127.0.0.1'),
  ANTLINGS_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  ANTLINGS_DATA_DIR: z.string().default('./data'),
  ANTLINGS_SECRET_KEY: z.string().optional(),
  ANTLINGS_HOME: z.string().optional(),
  ANTLINGS_CLAUDE_PATH: z.string().optional(),
  ANTLINGS_AUTH_MODE: z.enum(['apikey', 'subscription']).default('apikey'),
  ANTLINGS_SUBSCRIPTION_OK: z.enum(['0', '1']).default('0'),
  ANTLINGS_MAX_SESSIONS: z.coerce.number().int().min(1).max(8).default(2),
  ANTLINGS_MAX_SUBAGENTS: z.coerce.number().int().min(1).max(8).default(3),
  ANTLINGS_IDLE_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  ANTLINGS_STATIC_DIR: z.string().optional(),
  ANTLINGS_VAPID_PUBLIC: z.string().optional(),
  ANTLINGS_VAPID_PRIVATE: z.string().optional(),
  ANTLINGS_VAPID_SUBJECT: z.string().default('mailto:owner@localhost'),
});

export interface Config {
  origin: string;
  rpId: string;
  host: string;
  port: number;
  dataDir: string;
  secretKey: Buffer;
  home: string;
  claudePath?: string;
  authMode: 'apikey' | 'subscription';
  maxSessions: number;
  maxSubagents: number;
  idleHours: number;
  staticDir?: string;
  vapid?: { publicKey: string; privateKey: string; subject: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  const origin = new URL(e.ANTLINGS_ORIGIN);
  if (e.ANTLINGS_AUTH_MODE === 'subscription' && e.ANTLINGS_SUBSCRIPTION_OK !== '1') {
    throw new Error('subscription mode needs ANTLINGS_SUBSCRIPTION_OK=1 (see ADR 0003)');
  }
  const key = e.ANTLINGS_SECRET_KEY ? Buffer.from(e.ANTLINGS_SECRET_KEY, 'base64') : undefined;
  if (!key || key.length !== 32) throw new Error('ANTLINGS_SECRET_KEY must be 32 bytes, base64 encoded');
  return {
    origin: origin.origin,
    rpId: origin.hostname,
    host: e.ANTLINGS_HOST,
    port: e.ANTLINGS_PORT,
    dataDir: resolve(e.ANTLINGS_DATA_DIR),
    secretKey: key,
    home: resolve(e.ANTLINGS_HOME ?? homedir()),
    claudePath: e.ANTLINGS_CLAUDE_PATH,
    authMode: e.ANTLINGS_AUTH_MODE,
    maxSessions: e.ANTLINGS_MAX_SESSIONS,
    maxSubagents: e.ANTLINGS_MAX_SUBAGENTS,
    idleHours: e.ANTLINGS_IDLE_HOURS,
    staticDir: e.ANTLINGS_STATIC_DIR ? resolve(e.ANTLINGS_STATIC_DIR) : undefined,
    vapid:
      e.ANTLINGS_VAPID_PUBLIC && e.ANTLINGS_VAPID_PRIVATE
        ? {
            publicKey: e.ANTLINGS_VAPID_PUBLIC,
            privateKey: e.ANTLINGS_VAPID_PRIVATE,
            subject: e.ANTLINGS_VAPID_SUBJECT,
          }
        : undefined,
  };
}

export const dbPath = (c: Config): string => join(c.dataDir, 'antlings.db');
