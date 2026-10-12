import type { FastifyInstance } from 'fastify';
import type { WebSocketServer } from 'ws';
import type { Auth } from './auth/service.js';
import type { Folders } from './folders.js';
import { registerPushRoutes, type PushService } from './push.js';
import { registerSessionRoutes } from './sessionRoutes.js';
import type { SessionManager } from './sessions.js';
import type { Transcripts } from './transcripts.js';
import { attachWebSocket } from './ws.js';

export interface Wiring {
  auth: Auth;
  mgr: SessionManager;
  folders: Folders;
  transcripts: Transcripts;
  push?: PushService;
}

/** Adds the session routes and the WebSocket endpoint to an app built by `buildApp`. */
export function wireApp(app: FastifyInstance, w: Wiring): WebSocketServer {
  registerSessionRoutes(app, { mgr: w.mgr, folders: w.folders, transcripts: w.transcripts });
  const wss = attachWebSocket(app, w.auth, w.mgr, w.transcripts);
  if (w.push) registerPushRoutes(app, w.push);
  return wss;
}
