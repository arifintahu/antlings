import { buildApp } from './app.js';
import { Auth } from './auth/service.js';
import { realWebAuthn } from './auth/webauthn.js';
import { dbPath, loadConfig } from './config.js';
import { openDb } from './db.js';
import { loadEnvFileIfNeeded } from './env.js';
import { systemClock } from './util.js';

async function main(): Promise<void> {
  loadEnvFileIfNeeded();
  const config = loadConfig();
  const db = openDb(dbPath(config));
  const auth = new Auth(db, systemClock, config, realWebAuthn(config.rpId, config.origin));
  const app = await buildApp({ auth });
  await app.listen({ host: config.host, port: config.port });
  console.error(`antlings listening on ${config.host}:${config.port} (origin ${config.origin})`);
  const stop = async () => {
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
