import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSION_MODES, type SessionSummary } from '@antlings/shared';
import type { Effort } from './agent.js';
import { historyEvents } from './events.js';
import { FolderError, type Folders } from './folders.js';
import { LimitError, NotFoundError, type SessionManager } from './sessions.js';
import type { Transcripts, TranscriptInfo } from './transcripts.js';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_RE = /^[A-Za-z0-9_-]{1,100}$/;

const NewSessionBody = z.object({
  folder: z.string().max(1024),
  model: z.string().min(1).max(100),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  mode: z.enum(PERMISSION_MODES),
});
const PatchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
});
const CreateFolderBody = z.object({ parent: z.string().max(1024), name: z.string().max(200) });

export interface SessionRouteDeps {
  mgr: SessionManager;
  folders: Folders;
  transcripts: Transcripts;
}

export function registerSessionRoutes(app: FastifyInstance, d: SessionRouteDeps): void {
  const { mgr, folders, transcripts } = d;

  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof FolderError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'exists' ? 409 : 400;
      return reply.code(status).send({ error: e.code, message: e.message });
    }
    if (e instanceof LimitError) return reply.code(409).send({ error: 'session_limit', message: e.message });
    if (e instanceof NotFoundError) return reply.code(404).send({ error: 'not_found', message: e.message });
    throw e;
  };

  /** A transcript the owner may touch: valid id, and its folder is inside home. */
  const owned = async (id: string): Promise<TranscriptInfo | undefined> => {
    if (!ID_RE.test(id)) return undefined;
    // A session that has not had its first message yet exists only in Antlings' own metadata.
    const meta = mgr.meta(id);
    const info =
      (await transcripts.info(id)) ??
      (meta && { sessionId: id, summary: 'New session', lastModified: meta.createdAt, cwd: meta.cwd });
    if (!info?.cwd || folders.relative(info.cwd) === null) return undefined;
    return info;
  };

  const summary = (i: TranscriptInfo): SessionSummary => ({
    id: i.sessionId,
    title: i.customTitle ?? i.summary ?? i.firstPrompt ?? 'Session',
    cwd: folders.relative(i.cwd ?? '') ?? '',
    model: mgr.meta(i.sessionId)?.model,
    lastModified: i.lastModified,
    archived: i.tag === 'archived',
    running: mgr.isRunning(i.sessionId),
  });

  const body = <T>(schema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | undefined => {
    const r = schema.safeParse(req.body);
    if (r.success) return r.data;
    reply.code(400).send({ error: 'bad_request' });
    return undefined;
  };

  app.get('/api/models', async () => ({
    models: (await mgr.modelList()).map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      supportsEffort: !!m.supportsEffort,
      effortLevels: m.supportedEffortLevels ?? [],
    })),
  }));

  app.get('/api/usage', async () => ({ plan: mgr.plan }));

  app.get<{ Querystring: { path?: string } }>('/api/folders', async (req, reply) => {
    try {
      return folders.list(typeof req.query.path === 'string' ? req.query.path : '');
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/folders', async (req, reply) => {
    const b = body(CreateFolderBody, req, reply);
    if (!b) return;
    try {
      const path = folders.create(b.parent, b.name);
      app.auth.audit('folder_created', req.ip, { path });
      return { path };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Querystring: { archived?: string } }>('/api/sessions', async (req) => {
    const wantArchived = req.query.archived === '1';
    const all = await transcripts.list();
    return {
      sessions: all
        .filter((i) => i.cwd && folders.relative(i.cwd) !== null)
        .map(summary)
        .filter((s) => s.archived === wantArchived)
        .sort((a, b) => b.lastModified - a.lastModified),
    };
  });

  app.post('/api/sessions', async (req, reply) => {
    const b = body(NewSessionBody, req, reply);
    if (!b) return;
    try {
      const cwd = folders.resolve(b.folder);
      const models = await mgr.modelList();
      const model = models.find((m) => m.value === b.model);
      if (!model) return reply.code(400).send({ error: 'bad_model', message: 'Unknown model' });
      if (b.effort && !(model.supportsEffort && (model.supportedEffortLevels ?? []).includes(b.effort))) {
        return reply
          .code(400)
          .send({ error: 'bad_effort', message: 'That model does not support this effort level' });
      }
      // Bypass mode, and a session in the home folder itself, need a fresh passkey or code.
      if ((b.mode === 'bypassPermissions' || cwd === folders.home) && !app.requireFresh(req, reply)) return;
      const meta = await mgr.create({
        cwd,
        model: b.model,
        effort: b.effort as Effort | undefined,
        mode: b.mode,
      });
      return { id: meta.id };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const info = await owned(req.params.id);
    if (!info) return reply.code(404).send({ error: 'not_found' });
    await mgr.importHistory(info.sessionId);
    return {
      ...summary(info),
      meta: mgr.meta(info.sessionId) ?? null,
      pendingApprovals: mgr.pendingApprovals(info.sessionId),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const info = await owned(req.params.id);
    if (!info) return reply.code(404).send({ error: 'not_found' });
    const b = body(PatchBody, req, reply);
    if (!b) return;
    if (b.title !== undefined) await transcripts.rename(info.sessionId, b.title);
    if (b.archived !== undefined) {
      await transcripts.tag(info.sessionId, b.archived ? 'archived' : null);
      if (b.archived) mgr.close(info.sessionId);
      app.auth.audit(b.archived ? 'session_archived' : 'session_unarchived', req.ip, { id: info.sessionId });
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    if (!app.requireFresh(req, reply)) return;
    const info = await owned(req.params.id);
    if (!info) return reply.code(404).send({ error: 'not_found' });
    await mgr.remove(info.sessionId);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/subagents', async (req, reply) => {
    const info = await owned(req.params.id);
    if (!info) return reply.code(404).send({ error: 'not_found' });
    return { agents: (await transcripts.subagents(info.sessionId)).map((agentId) => ({ agentId })) };
  });

  app.get<{ Params: { id: string; agentId: string } }>(
    '/api/sessions/:id/subagents/:agentId',
    async (req, reply) => {
      const info = await owned(req.params.id);
      if (!info || !AGENT_RE.test(req.params.agentId)) return reply.code(404).send({ error: 'not_found' });
      return {
        events: historyEvents(await transcripts.subagentMessages(info.sessionId, req.params.agentId), 500),
      };
    },
  );
}
