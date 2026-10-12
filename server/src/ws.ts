import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientMessage, type ServerMessage } from '@antlings/shared';
import type { Effort } from './agent.js';
import type { Auth, SessionRow } from './auth/service.js';
import { LimitError, NotFoundError, type SessionManager } from './sessions.js';
import type { Transcripts } from './transcripts.js';

export const WS_MAX_PAYLOAD = 256 * 1024;
const RECHECK_MS = 15_000;

function refuse(socket: Duplex, code: number, text: string): void {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * WebSocket endpoint at /ws. An upgrade needs the exact Origin and a single-use ticket
 * created by a signed-in page. Every message is parsed with the shared schema.
 */
export function attachWebSocket(
  app: FastifyInstance,
  auth: Auth,
  mgr: SessionManager,
  transcripts: Transcripts,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  const sockets = new Set<WebSocket>();

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found');
    if (req.headers.origin !== auth.config.origin) return refuse(socket, 403, 'Forbidden');
    const sess = auth.consumeTicket(url.searchParams.get('ticket') ?? undefined);
    if (!sess) return refuse(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => connection(ws, sess));
  });

  function connection(ws: WebSocket, sess: SessionRow): void {
    sockets.add(ws);
    ws.on('error', () => undefined); // the library closes the socket itself, e.g. 1009 for an oversized message
    const subs = new Map<string, () => void>();
    const send = (m: ServerMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    const alive = (): SessionRow | undefined => {
      const row = auth.sessionById(sess.id);
      if (!row) ws.close(4401, 'signed out');
      return row;
    };
    const timer = setInterval(alive, RECHECK_MS);
    timer.unref();

    ws.on('close', () => {
      clearInterval(timer);
      sockets.delete(ws);
      for (const off of subs.values()) off();
    });

    ws.on('message', (data, isBinary) => {
      void (async () => {
        const row = alive();
        if (!row) return;
        let msg: ClientMessage;
        try {
          if (isBinary) throw new Error('binary');
          const parsed = ClientMessage.safeParse(JSON.parse(data.toString()));
          if (!parsed.success) throw new Error('shape');
          msg = parsed.data;
        } catch {
          return send({ t: 'error', code: 'bad_message', message: 'Message not understood' });
        }
        try {
          await handle(msg, row);
        } catch (e) {
          if (e instanceof LimitError) send({ t: 'error', code: 'session_limit', message: e.message });
          else if (e instanceof NotFoundError) send({ t: 'error', code: 'not_found', message: e.message });
          else {
            auth.log(`antlings-error ws ${(e instanceof Error ? e.message : 'unknown').slice(0, 200)}`);
            send({ t: 'error', code: 'failed', message: 'The action failed' });
          }
        }
      })();
    });

    async function handle(msg: ClientMessage, row: SessionRow): Promise<void> {
      switch (msg.t) {
        case 'hello': {
          if (!mgr.meta(msg.sessionId) && !(await transcripts.info(msg.sessionId)))
            throw new NotFoundError('Session not found');
          subs.get(msg.sessionId)?.();
          subs.set(msg.sessionId, mgr.subscribe(msg.sessionId, msg.lastSeq, send));
          return;
        }
        case 'send':
          return mgr.send(msg.sessionId, msg.text);
        case 'approve':
          if (!mgr.approve(msg.sessionId, msg.requestId, msg.updatedInput))
            send({ t: 'error', code: 'stale_request', message: 'That request is no longer waiting' });
          return;
        case 'deny':
          if (!mgr.deny(msg.sessionId, msg.requestId, msg.message))
            send({ t: 'error', code: 'stale_request', message: 'That request is no longer waiting' });
          return;
        case 'interrupt':
          return mgr.interrupt(msg.sessionId);
        case 'stopTask':
          return mgr.stopTask(msg.sessionId, msg.taskId);
        case 'setModel':
          return mgr.setModel(msg.sessionId, msg.model);
        case 'setPermissionMode':
          if (msg.mode === 'bypassPermissions' && !auth.isFresh(row)) {
            send({ t: 'error', code: 'stepup_required', message: 'Confirm with your passkey or code first' });
            return;
          }
          return mgr.setPermissionMode(msg.sessionId, msg.mode);
        case 'setEffort':
          return mgr.setEffort(msg.sessionId, msg.effort as Effort);
        case 'resume':
          return mgr.ensureRunning(msg.sessionId);
      }
    }
  }

  app.addHook('preClose', async () => {
    for (const ws of sockets) ws.terminate();
    wss.close();
  });

  return wss;
}
