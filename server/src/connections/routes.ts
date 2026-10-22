import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import { ClaudeApiKeyBody, ClaudeCodeBody, ClaudeModeBody, GitIdentityBody } from '@antlings/shared';
import { ConnError, type Connections } from './service.js';

/** Routes for the Connections page. Reads need a session; every change also needs a fresh check. */
export function registerConnectionRoutes(app: FastifyInstance, c: Connections): void {
  app.addHook('onClose', async () => c.dispose());

  const parse = <T>(schema: ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | undefined => {
    const r = schema.safeParse(req.body);
    if (r.success) return r.data;
    reply.code(400).send({ error: 'bad_request' });
    return undefined;
  };
  /** Runs a change: fresh check first, then the action; a refusal from the service becomes its status and code. */
  const change = async (
    req: FastifyRequest,
    reply: FastifyReply,
    action: () => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
  ) => {
    if (!app.requireFresh(req, reply)) return;
    try {
      return { ok: true, ...(await action()) };
    } catch (e) {
      if (!(e instanceof ConnError)) throw e;
      if (e.retryAfterSec) reply.header('Retry-After', String(e.retryAfterSec));
      return reply.code(e.status).send({ error: e.code });
    }
  };

  app.get('/api/connections', async () => c.snapshot());
  app.get('/api/connections/summary', async () => c.summary());

  app.post('/api/connections/github/start', (req, reply) => change(req, reply, () => c.githubStart(req.ip)));
  app.post('/api/connections/github/cancel', (req, reply) =>
    change(req, reply, () => c.githubCancel(req.ip)),
  );
  app.post('/api/connections/github/logout', (req, reply) =>
    change(req, reply, () => c.githubLogout(req.ip)),
  );
  app.post('/api/connections/git-identity', async (req, reply) => {
    const b = parse(GitIdentityBody, req, reply);
    if (b) return change(req, reply, () => c.setGitIdentity(b.name, b.email, req.ip));
  });

  app.post('/api/connections/claude/apikey', async (req, reply) => {
    const b = parse(ClaudeApiKeyBody, req, reply);
    if (b)
      return change(req, reply, async () => ({ verified: (await c.setApiKey(b.apiKey, req.ip)).verified }));
  });
  app.delete('/api/connections/claude/apikey', (req, reply) =>
    change(req, reply, () => c.clearApiKey(req.ip)),
  );
  app.post('/api/connections/claude/test', async (req, reply) => {
    if (!app.requireFresh(req, reply)) return;
    return { result: await c.testClaude() };
  });
  app.post('/api/connections/claude/mode', async (req, reply) => {
    const b = parse(ClaudeModeBody, req, reply);
    if (b) return change(req, reply, () => c.setMode(b.mode, b.ack, req.ip));
  });
  app.post('/api/connections/claude/login/start', (req, reply) =>
    change(req, reply, () => c.claudeStart(req.ip)),
  );
  app.post('/api/connections/claude/login/code', async (req, reply) => {
    const b = parse(ClaudeCodeBody, req, reply);
    if (b) return change(req, reply, () => c.claudeCode(b.code));
  });
  app.post('/api/connections/claude/login/cancel', (req, reply) =>
    change(req, reply, () => c.claudeCancel(req.ip)),
  );
  app.post('/api/connections/claude/logout', (req, reply) =>
    change(req, reply, () => c.claudeLogout(req.ip)),
  );
}
