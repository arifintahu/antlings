import { spawn, type ChildProcess } from 'node:child_process';
import { systemClock, type Clock } from '../util.js';

export type LoginState =
  | { phase: 'idle' }
  | { phase: 'starting' | 'waiting'; url?: string; code?: string; needsCode?: boolean; expiresAt: number }
  | { phase: 'done' }
  | { phase: 'error'; reason: 'no_url' | 'timeout' | 'failed' | 'unavailable' | 'cancelled' };

export interface LoginSpec {
  argv: string[];
  env: Record<string, string | undefined>;
  /** A login url is shown only when it is https and its host is one of these or a subdomain of one. */
  urlHosts: string[];
  parse(text: string): { url?: string; code?: string; needsCode?: boolean };
  timeoutMs: number;
  /** How long to wait for a url before giving up. */
  noUrlMs: number;
}

const BUFFER_MAX = 8 * 1024;

function allowedUrl(raw: string | undefined, hosts: string[]): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return undefined;
    return hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Runs one login CLI at a time and exposes only what the page needs: a url, a code and a phase. Raw output stays private. */
export class LoginRunner {
  private child?: ChildProcess;
  private current: LoginState = { phase: 'idle' };
  private buffer = '';
  private noUrlTimer?: NodeJS.Timeout;
  private timeoutTimer?: NodeJS.Timeout;

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly spawnFn: typeof spawn = spawn,
    private readonly onEnd?: (end: LoginState) => void,
  ) {}

  state(): LoginState {
    return this.current;
  }

  start(spec: LoginSpec): 'started' | 'busy' {
    if (this.child) return 'busy';
    this.buffer = '';
    const [cmd, ...args] = spec.argv;
    this.current = { phase: 'starting', expiresAt: this.clock.now() + spec.timeoutMs };
    let child: ChildProcess;
    try {
      child = this.spawnFn(cmd!, args, {
        shell: false,
        env: spec.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.current = { phase: 'error', reason: 'unavailable' };
      return 'started';
    }
    this.child = child;
    const onData = (d: Buffer) => this.onOutput(spec, d.toString('utf8'));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.stdin?.on('error', () => undefined);
    child.once('error', (e: NodeJS.ErrnoException) => {
      this.finish(child, { phase: 'error', reason: e.code === 'ENOENT' ? 'unavailable' : 'failed' });
    });
    child.once('close', (code) => {
      this.finish(child, code === 0 ? { phase: 'done' } : { phase: 'error', reason: 'failed' });
    });
    this.noUrlTimer = setTimeout(() => this.fail(child, 'no_url'), spec.noUrlMs);
    this.timeoutTimer = setTimeout(() => this.fail(child, 'timeout'), spec.timeoutMs);
    return 'started';
  }

  writeCode(code: string): boolean {
    const c = this.child;
    if (!c?.stdin?.writable) return false;
    c.stdin.write(`${code}\n`);
    return true;
  }

  cancel(): void {
    const c = this.child;
    if (c) this.fail(c, 'cancelled');
  }

  dispose(): void {
    const c = this.child;
    if (c) this.fail(c, 'cancelled');
    this.clearTimers();
  }

  private onOutput(spec: LoginSpec, text: string): void {
    this.buffer = (this.buffer + text).slice(-BUFFER_MAX);
    const cur = this.current;
    if (cur.phase !== 'starting' && cur.phase !== 'waiting') return;
    const p = spec.parse(this.buffer);
    const url = allowedUrl(p.url, spec.urlHosts) ?? ('url' in cur ? cur.url : undefined);
    const code = p.code ?? ('code' in cur ? cur.code : undefined);
    const needsCode = p.needsCode ?? ('needsCode' in cur ? cur.needsCode : undefined);
    if (!url && !code && !needsCode) return;
    this.current = {
      phase: 'waiting',
      ...(url ? { url } : {}),
      ...(code ? { code } : {}),
      ...(needsCode ? { needsCode } : {}),
      expiresAt: cur.expiresAt,
    };
    if (url) this.clearNoUrlTimer();
  }

  private fail(child: ChildProcess, reason: 'no_url' | 'timeout' | 'cancelled'): void {
    if (this.child !== child) return;
    this.finish(child, { phase: 'error', reason });
  }

  /** Records the end state once and makes sure the process is gone. */
  private finish(child: ChildProcess, end: LoginState): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.buffer = '';
    this.clearTimers();
    this.current = end;
    this.onEnd?.(end);
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      const hard = setTimeout(() => child.kill('SIGKILL'), 2000);
      hard.unref();
      child.once('close', () => clearTimeout(hard));
    }
  }

  private clearNoUrlTimer(): void {
    clearTimeout(this.noUrlTimer);
    this.noUrlTimer = undefined;
  }

  private clearTimers(): void {
    this.clearNoUrlTimer();
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }
}
