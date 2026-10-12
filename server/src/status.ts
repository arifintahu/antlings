import { readFileSync, statSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { Auth } from './auth/service.js';
import { dbPath } from './config.js';
import type { PushService } from './push.js';
import type { SessionManager } from './sessions.js';

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const startedAt = Date.now();

/** A small health report for the owner: version, memory, running sessions, database size, last sign-ins. */
export function registerStatusRoutes(
  app: FastifyInstance,
  auth: Auth,
  mgr: SessionManager,
  push?: PushService,
): void {
  const version = readVersion();
  app.get('/api/status', async () => {
    let dbBytes = 0;
    try {
      dbBytes = statSync(dbPath(auth.config)).size;
    } catch {
      /* in-memory database in tests */
    }
    const events = (auth.db.prepare('SELECT COUNT(*) AS n FROM event_log').get() as { n: number }).n;
    const lastSignin = auth.recentAudit(200).find((a) => a.kind === 'signin');
    return {
      version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      serviceMemoryMb: Math.round(process.memoryUsage().rss / 1048576),
      hostMemory: { freeMb: Math.round(freemem() / 1048576), totalMb: Math.round(totalmem() / 1048576) },
      sessions: { running: mgr.runningIds().length, max: auth.config.maxSessions },
      database: { sizeMb: Math.round((dbBytes / 1048576) * 10) / 10, events },
      lastSignin: lastSignin ? { at: lastSignin.at, ip: lastSignin.ip } : null,
      pushDevices: push?.count() ?? 0,
      eventKeep: auth.config.eventKeep,
    };
  });
}
