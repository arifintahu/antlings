import type { FastifyInstance } from 'fastify';
import type { WebSocketServer } from 'ws';
import type { Auth } from './auth/service.js';
import { registerConnectionRoutes } from './connections/routes.js';
import type { Connections } from './connections/service.js';
import type { Folders } from './folders.js';
import { registerPushRoutes, type PushService } from './push.js';
import { registerStatusRoutes } from './status.js';
import { ownedSession, registerSessionRoutes } from './sessionRoutes.js';
import type { Terminals } from './terminals/registry.js';
import { registerTerminalRoutes } from './terminals/routes.js';
import { attachTerminalSocket } from './terminals/ws.js';
import type { SessionManager } from './sessions.js';
import type { Transcripts } from './transcripts.js';
import { attachWebSocket } from './ws.js';

export interface Wiring {
  auth: Auth;
  mgr: SessionManager;
  folders: Folders;
  transcripts: Transcripts;
  connections: Connections;
  terms: Terminals;
  push?: PushService;
}

/** Adds the session routes and the WebSocket endpoint to an app built by `buildApp`. */
export function wireApp(app: FastifyInstance, w: Wiring): { wss: WebSocketServer; termWss: WebSocketServer } {
  registerSessionRoutes(app, { mgr: w.mgr, folders: w.folders, transcripts: w.transcripts, terms: w.terms });
  const owned = ownedSession({ mgr: w.mgr, folders: w.folders, transcripts: w.transcripts });
  registerTerminalRoutes(app, { terms: w.terms, owned });
  const termWss = attachTerminalSocket(app, w.auth, w.terms, owned);
  const wss = attachWebSocket(app, w.auth, w.mgr, w.transcripts);
  if (w.push) registerPushRoutes(app, w.push);
  registerStatusRoutes(app, w.auth, w.mgr, w.push);
  registerConnectionRoutes(app, w.connections);
  return { wss, termWss };
}
