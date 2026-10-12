import type { FastifyInstance } from 'fastify';
import type { Auth } from './auth/service.js';
import type { Folders } from './folders.js';
import { registerSessionRoutes } from './sessionRoutes.js';
import type { SessionManager } from './sessions.js';
import type { Transcripts } from './transcripts.js';
import { attachWebSocket } from './ws.js';

export interface Wiring {
  auth: Auth;
  mgr: SessionManager;
  folders: Folders;
  transcripts: Transcripts;
}

/** Adds the session routes and the WebSocket endpoint to an app built by `buildApp`. */
export function wireApp(app: FastifyInstance, w: Wiring): void {
  registerSessionRoutes(app, { mgr: w.mgr, folders: w.folders, transcripts: w.transcripts });
  attachWebSocket(app, w.auth, w.mgr, w.transcripts);
}
