// Test harness for the Playwright suite. Runs the real app (real WebAuthn, real sessions, real static files)
// with a fake agent instead of Claude Code. Never used in production: it adds unauthenticated /__e2e routes.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../app.js';
import { Auth } from '../auth/service.js';
import { realWebAuthn } from '../auth/webauthn.js';
import { dbPath, loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { FakeAgents, FakeTranscripts } from '../fakeAgent.js';
import { Folders } from '../folders.js';
import { SessionManager } from '../sessions.js';
import { systemClock } from '../util.js';
import { fileURLToPath } from 'node:url';
import { Connections } from '../connections/service.js';
import { ConnectionSettings } from '../connections/store.js';
import { wireApp } from '../wiring.js';

const port = Number(process.env.E2E_PORT ?? 3199);
const tmp = mkdtempSync(join(tmpdir(), 'antlings-e2e-'));
const home = join(tmp, 'home');
mkdirSync(join(home, 'proj'), { recursive: true });
mkdirSync(join(home, 'work'));

const config = loadConfig({
  ANTLINGS_ORIGIN: `http://localhost:${port}`,
  ANTLINGS_PORT: String(port),
  ANTLINGS_SECRET_KEY: randomBytes(32).toString('base64'),
  ANTLINGS_DATA_DIR: join(tmp, 'data'),
  ANTLINGS_HOME: home,
  ANTLINGS_STATIC_DIR: resolve(process.env.E2E_STATIC ?? '../web/dist'),
});
const db = openDb(dbPath(config));
const auth = new Auth(db, systemClock, config, realWebAuthn(config.rpId, config.origin), () => undefined);
const transcripts = new FakeTranscripts();

class Agents extends FakeAgents {
  override start(o: Parameters<FakeAgents['start']>[0]) {
    if (!transcripts.items.has(o.sessionId)) {
      transcripts.add(o.sessionId, { cwd: o.cwd, summary: 'New session', lastModified: Date.now() });
    }
    return super.start(o);
  }
}
const agents = new Agents();
const folders = new Folders(home);
const mgr = new SessionManager({
  db,
  clock: systemClock,
  config,
  agents,
  transcripts,
  audit: (k, d) => auth.audit(k, undefined, d),
});

const fakeCli = (name: string) => ({
  cmd: process.execPath,
  args: [fileURLToPath(new URL(`./fake-cli/${name}.mjs`, import.meta.url))],
});
// Moving this offset forward is how the browser tests get past the one-sign-in-a-minute limit.
let clockOffset = 0;
const connections = new Connections({
  auth,
  settings: new ConnectionSettings(auth),
  gh: fakeCli('gh'),
  claude: fakeCli('claude'),
  home,
  fetchFn: (async (_u: unknown, init?: RequestInit) =>
    new Response('{}', {
      status: new Headers(init?.headers).get('x-api-key')?.includes('bad') ? 401 : 200,
    })) as unknown as typeof fetch,
  clock: { now: () => Date.now() + clockOffset },
});

let sockets: ReturnType<typeof wireApp> | undefined;
const app = await buildApp({
  auth,
  extend: (a) => {
    sockets = wireApp(a, { auth, mgr, folders, transcripts, connections });
    const pub = { config: { public: true } };
    // Returns a fresh setup code. Resets access first when something is already set up.
    a.post('/__e2e/reset', pub, async () => {
      mgr.closeAll();
      transcripts.items.clear();
      db.prepare('DELETE FROM event_log').run();
      db.prepare('DELETE FROM session_meta').run();
      return auth.resetAccess();
    });
    // Back to a clean Connections page: fake CLIs signed out, stored Claude settings cleared, rate limit passed.
    a.post('/__e2e/connections-reset', pub, async () => {
      for (const f of ['.fake-gh-state', '.fake-claude-state', '.fake-hold', '.fake-gh-setup-git'])
        rmSync(join(home, f), { force: true });
      db.prepare(
        "DELETE FROM settings WHERE key IN ('claude_mode', 'anthropic_key', 'subscription_ack_at')",
      ).run();
      writeFileSync(join(home, '.fake-delay'), '3000');
      clockOffset += 61_000;
      return { ok: true };
    });
    a.post('/__e2e/unlock', pub, async () => {
      db.prepare('DELETE FROM lockouts').run();
      db.prepare('DELETE FROM auth_failures').run();
      return { ok: true };
    });
    // Adds a notice to a session's log, as if the agent had said it while the page was offline.
    a.post('/__e2e/emit', pub, async (req) => {
      const b = req.body as { sessionId: string; text: string };
      mgr.emit(b.sessionId, { k: 'notice', message: b.text });
      return { ok: true };
    });
    a.post('/__e2e/drop-sockets', pub, async () => {
      let n = 0;
      for (const c of sockets?.clients ?? []) {
        c.terminate();
        n++;
      }
      return { dropped: n };
    });
  },
});
await app.listen({ host: '127.0.0.1', port });
console.error(`e2e server on ${port}`);
