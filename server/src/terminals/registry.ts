import { randomBytes } from 'node:crypto';
import type { TerminalInfo, TerminalServerMessage } from '@antlings/shared';
import type { Clock } from '../util.js';
import type { PtyFactory, PtyProcess } from './pty.js';
import { Scrollback } from './scrollback.js';
import { pickShell, terminalEnv } from './shell.js';

export class TerminalLimitError extends Error {}
export class ShellUnavailableError extends Error {}

export type KillReason = 'user' | 'archive' | 'delete' | 'shutdown';

export interface TerminalClient {
  out(m: TerminalServerMessage): void;
  close(why: 'killed' | 'exited'): void;
}

interface Entry {
  info: TerminalInfo;
  pty: PtyProcess;
  scrollback: Scrollback;
  clients: Set<TerminalClient>;
  removed: boolean;
}

export interface TerminalsDeps {
  pty: PtyFactory;
  clock: Clock;
  audit: (kind: string, detail?: unknown) => void;
  env?: NodeJS.ProcessEnv;
  maxRunningPerSession?: number;
  maxRunningTotal?: number;
  maxEntriesPerSession?: number;
}

/** What an ended shell keeps of its output: enough to see why it ended. */
const EXITED_KEEP = 64 * 1024;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Every shell of every session. Shells live as long as this object; the agent idle reaper does not touch them. */
export class Terminals {
  private readonly sessions = new Map<string, Map<string, Entry>>();
  private readonly counters = new Map<string, number>();
  private readonly maxPerSession: number;
  private readonly maxTotal: number;
  private readonly maxEntries: number;

  constructor(private readonly d: TerminalsDeps) {
    this.maxPerSession = d.maxRunningPerSession ?? 4;
    this.maxTotal = d.maxRunningTotal ?? 12;
    this.maxEntries = d.maxEntriesPerSession ?? 8;
  }

  create(sessionId: string, cwd: string, size: { cols: number; rows: number }): TerminalInfo {
    const entries = this.sessions.get(sessionId) ?? new Map<string, Entry>();
    const running = [...entries.values()].filter((e) => e.info.running).length;
    if (running >= this.maxPerSession || this.runningCount() >= this.maxTotal) throw new TerminalLimitError();

    const { file, args } = pickShell(this.d.env ?? process.env);
    let pty: PtyProcess;
    try {
      pty = this.d.pty.spawn({
        file,
        args,
        cwd,
        env: terminalEnv(this.d.env ?? process.env),
        cols: clamp(size.cols, 20, 500),
        rows: clamp(size.rows, 5, 200),
      });
    } catch {
      throw new ShellUnavailableError();
    }

    if (entries.size >= this.maxEntries) {
      const oldestExited = [...entries.values()].find((e) => !e.info.running);
      if (oldestExited) entries.delete(oldestExited.info.id);
    }
    const n = (this.counters.get(sessionId) ?? 0) + 1;
    this.counters.set(sessionId, n);
    const entry: Entry = {
      info: {
        id: randomBytes(8).toString('hex'),
        name: `Shell ${n}`,
        running: true,
        exitCode: null,
        createdAt: this.d.clock.now(),
      },
      pty,
      scrollback: new Scrollback(),
      clients: new Set(),
      removed: false,
    };
    entries.set(entry.info.id, entry);
    this.sessions.set(sessionId, entries);

    pty.onData((data) => {
      if (entry.removed) return;
      entry.scrollback.append(data);
      for (const c of entry.clients) c.out({ t: 'out', d: data });
    });
    pty.onExit(({ exitCode }) => {
      if (entry.removed || !entry.info.running) return;
      entry.info.running = false;
      entry.info.exitCode = exitCode;
      entry.scrollback.shrink(EXITED_KEEP); // ended shells stay listed for a while; do not let them hold 1 MB each
      this.d.audit('terminal_closed', { sessionId, terminalId: entry.info.id, reason: 'exited' });
      const clients = [...entry.clients];
      entry.clients.clear();
      for (const c of clients) {
        c.out({ t: 'exit', code: exitCode });
        c.close('exited');
      }
    });

    this.d.audit('terminal_opened', { sessionId, terminalId: entry.info.id });
    return { ...entry.info };
  }

  list(sessionId: string): TerminalInfo[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])].map((e) => ({ ...e.info }));
  }

  /** Sends the scrollback and subscribes in one tick, so no output is lost or doubled in between. */
  attach(sessionId: string, terminalId: string, client: TerminalClient): (() => void) | undefined {
    const e = this.sessions.get(sessionId)?.get(terminalId);
    if (!e) return undefined;
    client.out({ t: 'replay', d: e.scrollback.text() });
    if (!e.info.running) {
      client.out({ t: 'exit', code: e.info.exitCode });
      client.close('exited');
      return () => undefined;
    }
    e.clients.add(client);
    return () => {
      e.clients.delete(client);
    };
  }

  write(sessionId: string, terminalId: string, data: string): boolean {
    const e = this.sessions.get(sessionId)?.get(terminalId);
    if (!e?.info.running) return false;
    e.pty.write(data);
    return true;
  }

  resize(sessionId: string, terminalId: string, cols: number, rows: number): boolean {
    const e = this.sessions.get(sessionId)?.get(terminalId);
    if (!e?.info.running) return false;
    e.pty.resize(clamp(cols, 20, 500), clamp(rows, 5, 200));
    return true;
  }

  kill(sessionId: string, terminalId: string, reason: KillReason = 'user'): boolean {
    const entries = this.sessions.get(sessionId);
    const e = entries?.get(terminalId);
    if (!entries || !e) return false;
    entries.delete(terminalId);
    if (entries.size === 0) this.sessions.delete(sessionId);
    e.removed = true;
    if (e.info.running) {
      e.info.running = false;
      e.pty.kill();
      this.d.audit('terminal_closed', { sessionId, terminalId, reason });
    }
    const clients = [...e.clients];
    e.clients.clear();
    for (const c of clients) c.close('killed');
    return true;
  }

  killSession(sessionId: string, reason: KillReason): number {
    const ids = [...(this.sessions.get(sessionId)?.keys() ?? [])];
    for (const id of ids) this.kill(sessionId, id, reason);
    return ids.length;
  }

  killAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.killSession(sessionId, 'shutdown');
  }

  runningCount(): number {
    let n = 0;
    for (const entries of this.sessions.values()) for (const e of entries.values()) if (e.info.running) n++;
    return n;
  }
}
