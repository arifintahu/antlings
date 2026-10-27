import { homedir } from 'node:os';
import { buildApp } from './app.js';
import { sdkAgentFactory } from './agent.js';
import { Auth } from './auth/service.js';
import { Connections } from './connections/service.js';
import { ConnectionSettings } from './connections/store.js';
import { realWebAuthn } from './auth/webauthn.js';
import { dbPath, loadConfig } from './config.js';
import { openDb } from './db.js';
import { loadEnvFileIfNeeded } from './env.js';
import { Folders } from './folders.js';
import { PushService } from './push.js';
import { repairStoredHistory, SessionManager } from './sessions.js';
import { sdkTranscripts } from './transcripts.js';
import { systemClock } from './util.js';
import { nodePtyFactory } from './terminals/pty.js';
import { Terminals } from './terminals/registry.js';
import { wireApp } from './wiring.js';

async function main(): Promise<void> {
  loadEnvFileIfNeeded();
  const config = loadConfig();
  const db = openDb(dbPath(config));
  const auth = new Auth(db, systemClock, config, realWebAuthn(config.rpId, config.origin));
  const settings = new ConnectionSettings(auth);
  const folders = new Folders(config.home);
  const repaired = repairStoredHistory(db);
  if (repaired > 0) console.error(`repaired ${repaired} stored history events`);
  const push = new PushService(db, systemClock, config.vapid);
  auth.onSignin = () => push.signedIn();
  const mgr = new SessionManager({
    db,
    clock: systemClock,
    config,
    agents: sdkAgentFactory(config, () => ({ mode: settings.mode(), apiKey: settings.apiKey() })),
    transcripts: sdkTranscripts,
    audit: (kind, detail) => auth.audit(kind, undefined, detail),
    notifier: push,
  });
  const connections = new Connections({
    auth,
    settings,
    gh: { cmd: config.ghPath ?? 'gh' },
    claude: { cmd: config.claudePath ?? 'claude' },
    home: homedir(),
    clock: systemClock,
  });
  const terms = new Terminals({
    pty: nodePtyFactory(),
    clock: systemClock,
    audit: (kind, detail) => auth.audit(kind, undefined, detail),
  });
  const app = await buildApp({
    auth,
    extend: (a) => {
      wireApp(a, { auth, mgr, folders, transcripts: sdkTranscripts, connections, terms, push });
    },
  });
  const reaper = setInterval(() => mgr.reapIdle(), 60_000);
  reaper.unref();
  await app.listen({ host: config.host, port: config.port });
  console.error(`antlings listening on ${config.host}:${config.port} (origin ${config.origin})`);
  const stop = async () => {
    clearInterval(reaper);
    mgr.closeAll();
    terms.killAll();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e: unknown) => {
  console.error('fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
