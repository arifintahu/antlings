#!/usr/bin/env node
import { Auth } from './auth/service.js';
import { realWebAuthn } from './auth/webauthn.js';
import { dbPath, loadConfig } from './config.js';
import { openDb } from './db.js';
import { loadEnvFileIfNeeded } from './env.js';
import { systemClock } from './util.js';

function main(argv: string[]): number {
  const cmd = argv[0];
  if (cmd !== 'setup' && cmd !== 'reset-access') {
    console.error('usage: antlings <setup | reset-access>');
    return 2;
  }
  loadEnvFileIfNeeded();
  const config = loadConfig();
  const db = openDb(dbPath(config));
  const auth = new Auth(db, systemClock, config, realWebAuthn(config.rpId, config.origin));
  if (cmd === 'setup' && auth.hasCredentials()) {
    console.error('Access is already set up. To start over, run: antlings reset-access');
    return 1;
  }
  const r = cmd === 'setup' ? auth.createSetupCode() : auth.resetAccess();
  const minutes = Math.round((r.expiresAt - Date.now()) / 60_000);
  console.log(`Setup code: ${r.code}`);
  console.log(`Valid for ${minutes} minutes. Open ${config.origin} and enter it.`);
  if (cmd === 'reset-access')
    console.log('All passkeys, the password fallback and every sign-in were removed.');
  db.close();
  return 0;
}

process.exitCode = main(process.argv.slice(2));
