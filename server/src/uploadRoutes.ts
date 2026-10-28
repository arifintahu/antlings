import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { MAX_FILE_BYTES, type AttachmentRef } from '@antlings/shared';
import type { ownedSession } from './sessionRoutes.js';
import { UploadError, type Uploads } from './uploads.js';

const STATUS = { empty: 400, too_large: 413, bad_type: 415, quota: 409 } as const;
/** A little room above the file limit, so a file just over it gets the readable `too_large` reply. */
const BODY_LIMIT = MAX_FILE_BYTES + 64 * 1024;

export interface UploadRouteDeps {
  uploads: Uploads;
  owned: ReturnType<typeof ownedSession>;
}

/** One file per request, sent as the raw body. The WebSocket never carries file bytes. */
export function registerUploadRoutes(app: FastifyInstance, d: UploadRouteDeps): void {
  const { uploads, owned } = d;
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/uploads',
    { bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const info = await owned(req.params.id);
      if (!info) return reply.code(404).send({ error: 'not_found' });
      let name: string;
      try {
        name = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
      } catch {
        return reply.code(400).send({ error: 'bad_request' });
      }
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const f = uploads.save(info.sessionId, name, data);
        const attachment: AttachmentRef = { id: f.id, name: f.name, size: f.size, kind: f.kind };
        return { attachment };
      } catch (e) {
        if (e instanceof UploadError)
          return reply.code(STATUS[e.code]).send({ error: e.code, message: e.message });
        throw e;
      }
    },
  );

  app.get<{ Params: { id: string; uploadId: string } }>(
    '/api/sessions/:id/uploads/:uploadId',
    async (req, reply) => {
      const info = await owned(req.params.id);
      const f = info && uploads.get(info.sessionId, req.params.uploadId);
      if (!f) return reply.code(404).send({ error: 'not_found' });
      const disposition =
        f.kind === 'image' ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`;
      return reply
        .header('content-type', f.mime)
        .header('content-disposition', disposition)
        .send(readFileSync(f.path));
    },
  );

  app.delete<{ Params: { id: string; uploadId: string } }>(
    '/api/sessions/:id/uploads/:uploadId',
    async (req, reply) => {
      const info = await owned(req.params.id);
      if (!info) return reply.code(404).send({ error: 'not_found' });
      const r = uploads.remove(info.sessionId, req.params.uploadId);
      if (r === 'missing') return reply.code(404).send({ error: 'not_found' });
      if (r === 'sent') return reply.code(409).send({ error: 'already_sent' });
      return { ok: true };
    },
  );
}
