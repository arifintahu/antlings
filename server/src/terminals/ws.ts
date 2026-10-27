import { TERMINAL_ID_RE, TerminalClientMessage, type TerminalServerMessage } from '@antlings/shared';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Auth, SessionRow } from '../auth/service.js';
import type { TranscriptInfo } from '../transcripts.js';
import { refuse, WS_MAX_PAYLOAD } from '../ws.js';
import type { Terminals } from './registry.js';

const RECHECK_MS = 15_000;
/** A client that has not read this much is not reading at all (a sleeping phone). It is dropped; the shell is not. */
export const MAX_BUFFERED = 4 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * WebSocket endpoint at /ws/term?ticket=&session=&terminal=. Same Origin and single-use ticket rules as /ws.
 * It attaches to a shell that already exists (made over REST) and never creates one.
 */
export function attachTerminalSocket(
  app: FastifyInstance,
  auth: Auth,
  terms: Terminals,
  owned: (id: string) => Promise<TranscriptInfo | undefined>,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  const sockets = new Set<WebSocket>();

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws/term') return;
    if (req.headers.origin !== auth.config.origin) return refuse(socket, 403, 'Forbidden');
    const sess = auth.consumeTicket(url.searchParams.get('ticket') ?? undefined);
    if (!sess) return refuse(socket, 401, 'Unauthorized');
    const sessionId = url.searchParams.get('session') ?? '';
    const terminalId = url.searchParams.get('terminal') ?? '';
    if (!UUID_RE.test(sessionId) || !TERMINAL_ID_RE.test(terminalId)) return refuse(socket, 404, 'Not Found');
    void (async () => {
      const info = await owned(sessionId);
      if (!info || !terms.list(info.sessionId).some((t) => t.id === terminalId)) {
        return refuse(socket, 404, 'Not Found');
      }
      wss.handleUpgrade(req, socket, head, (ws) => connection(ws, sess, info.sessionId, terminalId));
    })().catch(() => refuse(socket, 500, 'Internal Server Error'));
  });

  function connection(ws: WebSocket, sess: SessionRow, sessionId: string, terminalId: string): void {
    sockets.add(ws);
    ws.on('error', () => undefined); // the library closes the socket itself, e.g. 1009 for an oversized frame
    const send = (m: TerminalServerMessage): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate();
      ws.send(JSON.stringify(m));
    };
    // `touch` is false for the timer: an open but abandoned tab must not keep the idle timeout from firing.
    const alive = (touch = true): SessionRow | undefined => {
      const row = auth.sessionById(sess.id, touch);
      if (!row) ws.close(4401, 'signed out');
      return row;
    };

    const detach = terms.attach(sessionId, terminalId, {
      out: send,
      close: (why) => (why === 'exited' ? ws.close(1000, 'exited') : ws.close(4410, 'closed')),
    });
    if (!detach) return void ws.close(4410, 'closed');

    // The ping lets the page notice a dead connection (a phone that slept) and reconnect.
    let heard = true;
    ws.on('pong', () => (heard = true));
    const timer = setInterval(() => {
      if (!alive(false)) return;
      if (!heard) return ws.terminate();
      heard = false;
      ws.ping();
      send({ t: 'ping' });
    }, RECHECK_MS);
    timer.unref();

    ws.on('close', () => {
      clearInterval(timer);
      sockets.delete(ws);
      detach();
    });

    ws.on('message', (data, isBinary) => {
      if (!alive()) return;
      let msg: TerminalClientMessage;
      try {
        if (isBinary) throw new Error('binary');
        const parsed = TerminalClientMessage.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) throw new Error('shape');
        msg = parsed.data;
      } catch {
        return ws.close(1008, 'bad message');
      }
      if (msg.t === 'in') terms.write(sessionId, terminalId, msg.d);
      else terms.resize(sessionId, terminalId, msg.cols, msg.rows);
    });
  }

  app.addHook('preClose', async () => {
    for (const ws of sockets) ws.terminate();
    wss.close();
  });

  return wss;
}
