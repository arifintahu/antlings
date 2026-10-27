import type { PtyFactory, PtyProcess, PtySpawnOptions } from './pty.js';

/** A pty without a process, for unit tests and the browser test server. */
export class FakePty implements PtyProcess {
  readonly written: string[] = [];
  killed = false;
  size: { cols: number; rows: number };
  private dataCb: (d: string) => void = () => undefined;
  private exitCb: (e: { exitCode: number }) => void = () => undefined;
  private line = '';

  constructor(
    readonly pid: number,
    readonly opts: PtySpawnOptions,
    private readonly shell: boolean,
  ) {
    this.size = { cols: opts.cols, rows: opts.rows };
  }

  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }

  write(d: string): void {
    this.written.push(d);
    if (!this.shell) return;
    // Enough of a shell for the browser tests: echo what is typed, run `echo <text>` and `exit`.
    for (const ch of d) {
      if (ch !== '\r') {
        this.line += ch;
        this.emit(ch);
        continue;
      }
      const cmd = this.line.trim();
      this.line = '';
      this.emit('\r\n');
      if (cmd.startsWith('echo ')) this.emit(`${cmd.slice(5)}\r\n`);
      if (cmd === 'exit') return this.exitWith(0);
      this.emit('$ ');
    }
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
  }
  kill(): void {
    this.killed = true;
  }

  emit(d: string): void {
    this.dataCb(d);
  }
  exitWith(code: number): void {
    this.exitCb({ exitCode: code });
  }
}

export class FakePtyFactory implements PtyFactory {
  readonly spawned: FakePty[] = [];
  private failure: string | undefined;
  private nextPid = 1000;

  constructor(private readonly o: { shell?: boolean } = {}) {}

  failNext(message: string): void {
    this.failure = message;
  }

  spawn(opts: PtySpawnOptions): FakePty {
    if (this.failure !== undefined) {
      const m = this.failure;
      this.failure = undefined;
      throw new Error(m);
    }
    const pty = new FakePty(this.nextPid++, opts, this.o.shell === true);
    this.spawned.push(pty);
    if (this.o.shell) queueMicrotask(() => pty.emit('$ '));
    return pty;
  }
}
