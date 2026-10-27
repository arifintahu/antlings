import { TERMINAL_ID_RE, TerminalCreateBody } from '@antlings/shared';
import type { FastifyInstance } from 'fastify';
import type { TranscriptInfo } from '../transcripts.js';
import { ShellUnavailableError, TerminalLimitError, type Terminals } from './registry.js';

export interface TerminalRouteDeps {
  terms: Terminals;
  owned: (id: string) => Promise<TranscriptInfo | undefined>;
}

/** List, open and close shells. The folder comes from the stored session, never from the request. */
export function registerTerminalRoutes(app: FastifyInstance, d: TerminalRouteDeps): void {
  const { terms, owned } = d;

  app.get<{ Params: { id: string } }>('/api/sessions/:id/terminals', async (req, reply) => {
    const info = await owned(req.params.id);
    if (!info) return reply.code(404).send({ error: 'not_found' });
    return { terminals: terms.list(info.sessionId) };
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/terminals', async (req, reply) => {
    const info = await owned(req.params.id);
    if (!info?.cwd) return reply.code(404).send({ error: 'not_found' });
    const b = TerminalCreateBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (info.tag === 'archived') return reply.code(409).send({ error: 'archived' });
    try {
      return { terminal: terms.create(info.sessionId, info.cwd, b.data) };
    } catch (e) {
      if (e instanceof TerminalLimitError) return reply.code(409).send({ error: 'terminal_limit' });
      if (e instanceof ShellUnavailableError) return reply.code(503).send({ error: 'shell_unavailable' });
      throw e;
    }
  });

  app.delete<{ Params: { id: string; tid: string } }>(
    '/api/sessions/:id/terminals/:tid',
    async (req, reply) => {
      const info = await owned(req.params.id);
      if (!info || !TERMINAL_ID_RE.test(req.params.tid)) return reply.code(404).send({ error: 'not_found' });
      if (!terms.kill(info.sessionId, req.params.tid, 'user'))
        return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
}
