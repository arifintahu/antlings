import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginRunner, type LoginSpec, type LoginState } from './runner.js';

const URL_OK = 'https://github.com/login/device';
const parse = (text: string) => ({
  url: /https?:\/\/\S+/.exec(text)?.[0],
  code: /CODE (\S+)/.exec(text)?.[1],
  needsCode: /NEEDCODE/.test(text) || undefined,
});

function spec(script: string, over: Partial<LoginSpec> = {}): LoginSpec {
  return {
    argv: [process.execPath, '-e', script],
    env: { PATH: process.env.PATH },
    urlHosts: ['github.com'],
    parse,
    timeoutMs: 5000,
    noUrlMs: 2000,
    ...over,
  };
}

async function until(r: LoginRunner, pred: (s: LoginState) => boolean, ms = 4000): Promise<LoginState> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred(r.state())) return r.state();
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out; state ${JSON.stringify(r.state())}`);
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let runner: LoginRunner;
let spawned: number[] = [];
const counting = ((...a: Parameters<typeof spawn>) => {
  const c = spawn(...a);
  if (c.pid) spawned.push(c.pid);
  return c;
}) as typeof spawn;

afterEach(() => {
  runner?.dispose();
  spawned = [];
});

describe('LoginRunner', () => {
  it('reports the url and code, then done after a clean exit', async () => {
    runner = new LoginRunner(undefined, counting);
    const s = `console.log('CODE AB-12'); console.log('${URL_OK}'); setTimeout(()=>process.exit(0), 300)`;
    expect(runner.start(spec(s))).toBe('started');
    const w = await until(runner, (x) => x.phase === 'waiting' && 'url' in x && !!x.url);
    expect(w).toMatchObject({ phase: 'waiting', url: URL_OK, code: 'AB-12' });
    await until(runner, (x) => x.phase === 'done');
  });

  it('refuses a second start while one runs and spawns nothing', async () => {
    runner = new LoginRunner(undefined, counting);
    const s = `console.log('${URL_OK}'); setInterval(()=>{}, 1000)`;
    expect(runner.start(spec(s))).toBe('started');
    expect(runner.start(spec(s))).toBe('busy');
    expect(spawned).toHaveLength(1);
  });

  it('fails with no_url and kills the child when nothing parseable appears', async () => {
    runner = new LoginRunner(undefined, counting);
    runner.start(spec('setInterval(()=>{}, 1000)', { noUrlMs: 200 }));
    await until(runner, (x) => x.phase === 'error');
    expect(runner.state()).toEqual({ phase: 'error', reason: 'no_url' });
    const pid = spawned[0]!;
    await until(runner, () => !alive(pid));
  });

  it('does not show a url on an unlisted host or without https', async () => {
    runner = new LoginRunner(undefined, counting);
    const s = `console.log('CODE ZZ-99'); console.log('https://evil.example.net/x'); console.log('http://github.com/y'); setInterval(()=>{}, 1000)`;
    runner.start(spec(s, { noUrlMs: 400 }));
    const w = await until(runner, (x) => x.phase === 'waiting');
    expect('url' in w && w.url).toBeFalsy();
    await until(runner, (x) => x.phase === 'error');
    expect(runner.state()).toEqual({ phase: 'error', reason: 'no_url' });
  });

  it('maps exit 1 to failed and a missing binary to unavailable', async () => {
    runner = new LoginRunner(undefined, counting);
    runner.start(spec(`console.log('${URL_OK}'); process.exit(1)`));
    await until(runner, (x) => x.phase === 'error');
    expect(runner.state()).toEqual({ phase: 'error', reason: 'failed' });
    runner.start({ ...spec(''), argv: ['antlings-no-such-binary'] });
    await until(runner, (x) => x.phase === 'error' && x.reason === 'unavailable');
  });

  it('times out a login that never ends', async () => {
    runner = new LoginRunner(undefined, counting);
    runner.start(spec(`console.log('${URL_OK}'); setInterval(()=>{}, 1000)`, { timeoutMs: 300 }));
    await until(runner, (x) => x.phase === 'error');
    expect(runner.state()).toEqual({ phase: 'error', reason: 'timeout' });
    await until(runner, () => !alive(spawned[0]!));
  });

  it('writes a pasted code to stdin and finishes', async () => {
    runner = new LoginRunner(undefined, counting);
    const s = `console.log('NEEDCODE'); console.log('${URL_OK}');
      process.stdin.once('data', (d)=>{ if (String(d)==='abc123\\n') process.exit(0); process.exit(3) })`;
    runner.start(spec(s));
    const w = await until(runner, (x) => x.phase === 'waiting' && 'needsCode' in x && !!x.needsCode);
    expect(w).toMatchObject({ needsCode: true });
    expect(runner.writeCode('abc123')).toBe(true);
    await until(runner, (x) => x.phase === 'done');
    expect(runner.writeCode('late')).toBe(false);
  });

  it('cancel and dispose kill the child', async () => {
    runner = new LoginRunner(undefined, counting);
    runner.start(spec(`console.log('${URL_OK}'); setInterval(()=>{}, 1000)`));
    await until(runner, (x) => x.phase === 'waiting');
    runner.cancel();
    expect(runner.state()).toEqual({ phase: 'error', reason: 'cancelled' });
    await until(runner, () => !alive(spawned[0]!));
    runner.start(spec(`console.log('${URL_OK}'); setInterval(()=>{}, 1000)`));
    const second = spawned[1]!;
    runner.dispose();
    await until(runner, () => !alive(second));
  });

  it('never exposes raw output in its state', async () => {
    runner = new LoginRunner(undefined, counting);
    const s = `console.log('SECRET-MARKER-123'); console.log('${URL_OK}'); setInterval(()=>{}, 1000)`;
    runner.start(spec(s));
    await until(runner, (x) => x.phase === 'waiting' && 'url' in x && !!x.url);
    expect(JSON.stringify(runner.state())).not.toContain('SECRET-MARKER');
  });

  it('calls onEnd once with the end state', async () => {
    const ends: LoginState[] = [];
    runner = new LoginRunner(undefined, counting, (s) => ends.push(s));
    runner.start(spec(`console.log('${URL_OK}'); setTimeout(()=>process.exit(0), 100)`));
    await until(runner, (x) => x.phase === 'done');
    runner.cancel();
    expect(ends).toEqual([{ phase: 'done' }]);
  });

  it('still times out when the child keeps printing after the url', async () => {
    runner = new LoginRunner(undefined, counting);
    const s = `console.log('${URL_OK}'); setTimeout(()=>console.log('Paste code here'), 100); setInterval(()=>{}, 1000)`;
    runner.start(spec(s, { timeoutMs: 600 }));
    await until(runner, (x) => x.phase === 'error', 3000);
    expect(runner.state()).toEqual({ phase: 'error', reason: 'timeout' });
    await until(runner, () => !alive(spawned[0]!));
  });
});
