import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodePtyFactory } from './pty.js';
import { pickShell, terminalEnv } from './shell.js';

// Opt-in: needs a Linux box with the native module built. ANTLINGS_PTY=1 pnpm --filter @antlings/server test
describe.skipIf(!process.env.ANTLINGS_PTY || process.platform === 'win32')('real pty', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('starts in the folder and kill() takes the shell and its children with it', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'antlings-pty-')));
    const { file, args } = pickShell(process.env);
    const pty = nodePtyFactory().spawn({
      file,
      args,
      cwd: dir,
      env: terminalEnv(process.env),
      cols: 80,
      rows: 24,
    });
    let out = '';
    pty.onData((d) => (out += d));
    const until = async (pred: () => boolean, ms: number) => {
      for (const start = Date.now(); !pred();) {
        if (Date.now() - start > ms)
          throw new Error(`timeout; output so far: ${JSON.stringify(out.slice(-200))}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    pty.write('pwd\r');
    await until(() => out.includes(`${dir}\r\n`), 5000);
    expect(out).toContain(dir);
    pty.write('sleep 600\r');
    await until(() => pgrep(600), 5000);
    pty.kill();
    await until(() => !alive(pty.pid) && !pgrep(600), 5000);
  });

  it('also ends jobs that ignore SIGHUP and sit in their own process group', async () => {
    const { file, args } = pickShell(process.env);
    const pty = nodePtyFactory().spawn({
      file,
      args,
      cwd: tmpdir(),
      env: terminalEnv(process.env),
      cols: 80,
      rows: 24,
    });
    pty.onData(() => undefined);
    const until = async (pred: () => boolean, ms: number) => {
      for (const start = Date.now(); !pred();) {
        if (Date.now() - start > ms) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    pty.write('trap "" HUP; nohup sleep 603 >/dev/null 2>&1 &\r');
    await until(() => pgrep(603), 5000);
    pty.kill();
    await until(() => !pgrep(603), 8000);
  });
});

function pgrep(seconds: number): boolean {
  try {
    return (
      execFileSync('pgrep', ['-f', `sleep ${seconds}`])
        .toString()
        .trim().length > 0
    );
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}
