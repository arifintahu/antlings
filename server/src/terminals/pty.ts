import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export interface PtyProcess {
  readonly pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyFactory {
  spawn(o: PtySpawnOptions): PtyProcess;
}

/** The real pty. node-pty is native, so it loads on the first spawn: a missing binary fails one terminal, not the server start. */
export function nodePtyFactory(): PtyFactory {
  let lib: typeof import('node-pty') | undefined;
  return {
    spawn(o) {
      lib ??= createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
      const p = lib.spawn(o.file, o.args, {
        name: 'xterm-256color',
        cols: o.cols,
        rows: o.rows,
        cwd: o.cwd,
        env: o.env,
      });
      return {
        pid: p.pid,
        onData: (cb) => void p.onData(cb),
        onExit: (cb) => void p.onExit((e) => cb({ exitCode: e.exitCode })),
        write: (d) => p.write(d),
        resize: (c, r) => p.resize(c, r),
        kill() {
          if (process.platform === 'win32') return p.kill();
          // node-pty makes the shell a session leader. SIGHUP reaches its process group; a job with job control sits in
          // its own group, and a job may ignore SIGHUP, so after 2 s every process of the session gets SIGKILL.
          // This timer is not cancelled when the shell exits: the jobs are what is left to clean up.
          signal(-p.pid, 'SIGHUP');
          setTimeout(() => {
            signal(-p.pid, 'SIGKILL');
            for (const pid of sessionMembers(p.pid)) signal(pid, 'SIGKILL');
          }, 2000).unref();
        },
      };
    },
  };
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

/** Every live process whose session id is `sid`, read from /proc (Linux). A shell's jobs keep its session id after it exits. */
export function sessionMembers(sid: number): number[] {
  const pids: number[] = [];
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return pids;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // pid (comm) state ppid pgrp session ...; comm may hold spaces and brackets, so count from the last ")"
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[3]) === sid) pids.push(Number(name));
    } catch {
      /* the process ended while we looked */
    }
  }
  return pids;
}
