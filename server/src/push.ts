import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Notifier } from './sessions.js';
import type { Clock } from './util.js';

const Subscription = z.object({
  endpoint: z.string().url().max(2000).startsWith('https://'),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  sessionId?: string;
}

/** Web Push to the owner's devices. Subscriptions are in SQLite; dead ones are removed on 404 or 410. */
export class PushService implements Notifier {
  constructor(
    private db: Db,
    private clock: Clock,
    private vapid: Config['vapid'],
    private send: typeof webpush.sendNotification = webpush.sendNotification.bind(webpush),
  ) {
    if (vapid) webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  get publicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }

  save(sub: z.infer<typeof Subscription>): void {
    this.db
      .prepare(
        'INSERT INTO push_subscriptions (endpoint, data, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data',
      )
      .run(sub.endpoint, JSON.stringify(sub), this.clock.now());
  }

  remove(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n;
  }

  async notify(p: PushPayload): Promise<void> {
    if (!this.vapid) return;
    const rows = this.db.prepare('SELECT endpoint, data FROM push_subscriptions').all() as {
      endpoint: string;
      data: string;
    }[];
    await Promise.all(
      rows.map(async (r) => {
        try {
          await this.send(JSON.parse(r.data), JSON.stringify(p), { TTL: 3600 });
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.remove(r.endpoint);
        }
      }),
    );
  }

  approvalWaiting(sessionId: string, toolName: string): void {
    void this.notify({
      title: 'Approval needed',
      body: `A session wants to run ${toolName}.`,
      tag: `approval-${sessionId}`,
      sessionId,
    });
  }

  sessionFinished(sessionId: string): void {
    void this.notify({
      title: 'Session finished',
      body: 'A session finished its turn.',
      tag: `done-${sessionId}`,
      sessionId,
    });
  }

  signedIn(): void {
    void this.notify({ title: 'New sign-in', body: 'Someone signed in to Antlings.', tag: 'signin' });
  }
}

export function registerPushRoutes(app: FastifyInstance, push: PushService): void {
  app.get('/api/push/key', async () => ({ key: push.publicKey }));

  app.post('/api/push/subscribe', async (req, reply) => {
    const r = Subscription.safeParse(req.body);
    if (!r.success) return reply.code(400).send({ error: 'bad_request' });
    push.save(r.data);
    return { ok: true };
  });

  app.delete<{ Querystring: { endpoint?: string } }>('/api/push/subscribe', async (req, reply) => {
    if (typeof req.query.endpoint !== 'string' || req.query.endpoint.length > 2000) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    push.remove(req.query.endpoint);
    return { ok: true };
  });
}
