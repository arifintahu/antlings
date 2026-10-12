import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sdkAgentFactory } from './agent.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { SessionManager } from './sessions.js';
import { sdkTranscripts } from './transcripts.js';
import { systemClock } from './util.js';

// Opt-in: ANTLINGS_LIVE=1 pnpm --filter @antlings/server test. Uses Haiku, at most 0.10 USD per test, 2 turns.
const live = process.env.ANTLINGS_LIVE === '1';

const until = async (pred: () => boolean, ms: number) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe.skipIf(!live)('live SDK', () => {
  it('starts, answers one tiny turn, reports context, closes, and resumes after a "restart"', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'antlings-live-')));
    mkdirSync(cwd, { recursive: true });
    const stub = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    const db = openDb(':memory:');
    const config = loadConfig({
      ANTLINGS_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
      ANTLINGS_HOME: tmpdir(),
      ANTLINGS_AUTH_MODE: process.env.ANTHROPIC_API_KEY ? 'apikey' : 'subscription',
      ANTLINGS_SUBSCRIPTION_OK: '1',
    });
    const make = () =>
      new SessionManager({
        db,
        clock: systemClock,
        config,
        agents: sdkAgentFactory(config),
        transcripts: sdkTranscripts,
        audit: () => undefined,
        maxBudgetUsd: 0.1,
      });
    let mgr = make();
    let id = '';
    try {
      const meta = await mgr.create({ cwd, model: 'haiku', mode: 'default' });
      id = meta.id;
      await mgr.send(id, 'Reply with exactly: ok');
      await until(() => mgr.eventsAfter(id, 0).some((e) => e.event.k === 'context'), 90_000);
      const evs = mgr.eventsAfter(id, 0).map((e) => e.event);
      expect(evs.some((e) => e.k === 'assistant_text')).toBe(true);
      const ctx = evs.find((e) => e.k === 'context');
      expect(ctx).toMatchObject({ percentage: expect.any(Number) });
      console.log('live: plan usage', JSON.stringify(evs.find((e) => e.k === 'plan_usage')));
      mgr.close(id);
      await until(() => !mgr.isRunning(id), 10_000);
      await new Promise((r) => setTimeout(r, 200));

      // simulate a backend restart: new manager, same database
      mgr = make();
      await mgr.send(id, 'Reply with exactly: again');
      await until(() => mgr.eventsAfter(id, 0).filter((e) => e.event.k === 'turn_done').length >= 2, 90_000);
      expect(mgr.eventsAfter(id, 0).filter((e) => e.event.k === 'user')).toHaveLength(2);
    } finally {
      mgr.closeAll();
      await new Promise((r) => setTimeout(r, 300));
      if (id) await sdkTranscripts.remove(id).catch(() => undefined);
      rmSync(stub, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }, 240_000);
});
