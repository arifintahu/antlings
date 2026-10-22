import { join } from 'node:path';
import type { Auth } from '../auth/service.js';
import type { Clock } from '../util.js';
import {
  checkAnthropicKey,
  claudeLoginSpec,
  claudeStatus,
  ghStatus,
  githubLoginSpec,
  runCli,
  type Cli,
  type CliState,
} from './cli.js';
import { LoginRunner, type LoginState } from './runner.js';
import type { ClaudeMode, ConnectionSettings } from './store.js';

/** A refusal the routes turn into an HTTP status and an error code. Never carries secrets. */
export class ConnError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSec?: number,
  ) {
    super(code);
  }
}

export interface ConnectionsDeps {
  auth: Auth;
  settings: ConnectionSettings;
  gh: Cli;
  claude: Cli;
  git?: Cli;
  /** The service user's home. Every child runs with this HOME so its login lands in the right place. */
  home: string;
  fetchFn?: typeof fetch;
  clock: Clock;
}

export interface ConnectionsDto {
  claude: {
    mode: ClaudeMode;
    apiKeySet: boolean;
    envKeySet: boolean;
    ackedAt: number | null;
    cli: { state: CliState; method?: string; plan?: string };
    login: LoginState;
  };
  github: {
    cli: { state: CliState; login?: string };
    login: LoginState;
    git: { name?: string; email?: string };
  };
  fallbackCommands: { claude: string; github: string };
}

const START_GAP_MS = 60_000;
const isActive = (s: LoginState): boolean => s.phase === 'starting' || s.phase === 'waiting';

export class Connections {
  private readonly github: LoginRunner;
  private readonly claudeRunner: LoginRunner;
  private readonly lastStart = new Map<'github' | 'claude', number>();
  private readonly git: Cli;
  /** CLI status is slow (it starts Claude Code), so a poll during a login reuses the last answer. */
  private status?: {
    gh: Awaited<ReturnType<typeof ghStatus>>;
    claude: Awaited<ReturnType<typeof claudeStatus>>;
    name?: string;
    email?: string;
  };

  constructor(private readonly d: ConnectionsDeps) {
    this.git = d.git ?? { cmd: 'git' };
    this.github = new LoginRunner(d.clock, undefined, (end) => {
      if (end.phase !== 'done') return;
      d.auth.audit('connect_done', undefined, { provider: 'github' });
      void runCli(d.gh, ['auth', 'setup-git'], { env: this.env(), timeoutMs: 10_000 });
    });
    this.claudeRunner = new LoginRunner(d.clock, undefined, (end) => {
      if (end.phase === 'done') d.auth.audit('connect_done', undefined, { provider: 'claude' });
    });
  }

  dispose(): void {
    this.github.dispose();
    this.claudeRunner.dispose();
  }

  /** The only environment a login or status child gets. */
  private env(): Record<string, string | undefined> {
    return {
      HOME: this.d.home,
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? 'C.UTF-8',
      BROWSER: 'true',
      NO_COLOR: '1',
      GH_PROMPT_DISABLED: '1',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
  }
  private gitEnv(): Record<string, string | undefined> {
    return { ...this.env(), GIT_CONFIG_GLOBAL: join(this.d.home, '.gitconfig') };
  }

  private async gitGet(key: string): Promise<string | undefined> {
    const r = await runCli(this.git, ['config', '--global', '--get', key], {
      env: this.gitEnv(),
      timeoutMs: 5000,
    });
    const v = r.out.trim();
    return r.code === 0 && v ? v : undefined;
  }

  async snapshot(): Promise<ConnectionsDto> {
    const { settings } = this.d;
    const loginRunning = isActive(this.github.state()) || isActive(this.claudeRunner.state());
    if (!(loginRunning && this.status)) {
      const [gh, claude, name, email] = await Promise.all([
        ghStatus(this.d.gh, this.env()),
        claudeStatus(this.d.claude, this.env()),
        this.gitGet('user.name'),
        this.gitGet('user.email'),
      ]);
      this.status = { gh, claude, name, email };
    }
    const { gh, claude, name, email } = this.status;
    return {
      claude: {
        mode: settings.mode(),
        apiKeySet: settings.hasApiKey(),
        envKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
        ackedAt: settings.ackAt() ?? null,
        cli: claude,
        login: this.claudeRunner.state(),
      },
      github: {
        cli: gh,
        login: this.github.state(),
        git: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
      },
      fallbackCommands: {
        claude: 'sudo -u antlings -H claude login',
        github: 'sudo -u antlings -H gh auth login',
      },
    };
  }

  // ---- GitHub ----

  githubStart(ip: string): void {
    this.begin('github', this.github, () => githubLoginSpec(this.d.gh, this.env()));
    this.d.auth.audit('connect_start', ip, { provider: 'github' });
  }
  githubCancel(ip: string): void {
    this.github.cancel();
    this.d.auth.audit('connect_cancel', ip, { provider: 'github' });
  }
  async githubLogout(ip: string): Promise<void> {
    await runCli(this.d.gh, ['auth', 'logout', '--hostname', 'github.com'], {
      env: this.env(),
      timeoutMs: 10_000,
    });
    this.d.auth.audit('connect_logout', ip, { provider: 'github' });
  }
  async setGitIdentity(name: string, email: string, ip: string): Promise<void> {
    for (const [key, value] of [
      ['user.name', name],
      ['user.email', email],
    ] as const) {
      const r = await runCli(this.git, ['config', '--global', key, value], {
        env: this.gitEnv(),
        timeoutMs: 5000,
      });
      if (r.code !== 0) throw new ConnError(500, 'git_failed');
    }
    this.d.auth.audit('git_identity', ip, {});
  }

  // ---- Claude ----

  /** Stores the key after asking Anthropic. A key it rejects is not stored. */
  async setApiKey(key: string, ip: string): Promise<{ verified: boolean }> {
    const result = await checkAnthropicKey(key, this.d.fetchFn);
    if (result === 'rejected') throw new ConnError(400, 'key_rejected');
    this.d.settings.setApiKey(key);
    this.d.auth.audit('claude_key_set', ip, { verified: result === 'ok' });
    return { verified: result === 'ok' };
  }
  clearApiKey(ip: string): void {
    this.d.settings.clearApiKey();
    this.d.auth.audit('claude_key_cleared', ip, {});
  }
  async testClaude(): Promise<'ok' | 'rejected' | 'unreachable' | 'signed_out' | 'no_key'> {
    if (this.d.settings.mode() === 'subscription') {
      const s = await claudeStatus(this.d.claude, this.env());
      return s.state === 'signed_in' ? 'ok' : 'signed_out';
    }
    const key = this.d.settings.apiKey() ?? process.env.ANTHROPIC_API_KEY;
    return key ? checkAnthropicKey(key, this.d.fetchFn) : 'no_key';
  }
  setMode(mode: ClaudeMode, ack: boolean | undefined, ip: string): void {
    if (mode === 'subscription') {
      if (!ack && this.d.settings.ackAt() === undefined) throw new ConnError(400, 'ack_required');
      if (ack) this.d.settings.setAck(this.d.clock.now());
    }
    this.d.settings.setMode(mode);
    this.d.auth.audit('claude_mode', ip, { mode });
  }
  claudeStart(ip: string): void {
    if (this.d.settings.mode() !== 'subscription' || this.d.settings.ackAt() === undefined)
      throw new ConnError(409, 'wrong_mode');
    this.begin('claude', this.claudeRunner, () => claudeLoginSpec(this.d.claude, this.env()));
    this.d.auth.audit('connect_start', ip, { provider: 'claude' });
  }
  claudeCode(code: string): void {
    if (!this.claudeRunner.writeCode(code)) throw new ConnError(409, 'not_running');
  }
  claudeCancel(ip: string): void {
    this.claudeRunner.cancel();
    this.d.auth.audit('connect_cancel', ip, { provider: 'claude' });
  }
  async claudeLogout(ip: string): Promise<void> {
    await runCli(this.d.claude, ['auth', 'logout'], { env: this.env(), timeoutMs: 10_000 });
    this.d.auth.audit('connect_logout', ip, { provider: 'claude' });
  }

  /** One login at a time across both providers, and one start a minute per provider. */
  private begin(
    which: 'github' | 'claude',
    runner: LoginRunner,
    spec: () => ReturnType<typeof githubLoginSpec>,
  ): void {
    if (isActive(this.github.state()) || isActive(this.claudeRunner.state()))
      throw new ConnError(409, 'busy');
    const last = this.lastStart.get(which);
    const now = this.d.clock.now();
    if (last !== undefined && now - last < START_GAP_MS)
      throw new ConnError(429, 'too_soon', Math.ceil((START_GAP_MS - (now - last)) / 1000));
    this.lastStart.set(which, now);
    runner.start(spec());
  }
}
