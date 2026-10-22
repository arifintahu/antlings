// Shapes of GET /api/connections and the text and polling the Connections page needs.
// The server owns these types; they are repeated here so the web app never imports server code.

export type CliState = 'unavailable' | 'signed_out' | 'signed_in';
export type Provider = 'github' | 'claude';

export type LoginState =
  | { phase: 'idle' }
  | { phase: 'starting' | 'waiting'; url?: string; code?: string; needsCode?: boolean; expiresAt: number }
  | { phase: 'done' }
  | { phase: 'error'; reason: 'no_url' | 'timeout' | 'failed' | 'unavailable' | 'cancelled' };

export interface ConnectionsDto {
  claude: {
    mode: 'apikey' | 'subscription';
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

const NAME: Record<Provider, string> = { github: 'GitHub', claude: 'Claude' };

/** One line of plain text for a sign-in state. It never contains the device code or the url. */
export function stateLabel(s: LoginState, provider: Provider): string {
  switch (s.phase) {
    case 'idle':
      return 'Not started.';
    case 'starting':
      return 'Starting the sign-in…';
    case 'waiting':
      if (s.needsCode) return `Open the link, sign in to ${NAME[provider]}, then paste the code below.`;
      if (s.code) return `Waiting for you to approve on ${NAME[provider]}.`;
      return 'Starting the sign-in…';
    case 'done':
      return 'Signed in.';
    case 'error':
      switch (s.reason) {
        case 'no_url':
          return 'The sign-in did not start. Run the command shown below on the server instead.';
        case 'timeout':
          return 'The sign-in timed out. Start it again.';
        case 'failed':
          return 'The sign-in failed. Start it again.';
        case 'unavailable':
          return `${NAME[provider]}'s command is not installed on this server.`;
        case 'cancelled':
          return 'Sign-in cancelled.';
      }
  }
}

export const connectionTone = (cli: { state: CliState }): 'ok' | 'warn' | 'idle' =>
  cli.state === 'signed_in' ? 'ok' : cli.state === 'unavailable' ? 'warn' : 'idle';

export const loginActive = (s: LoginState): boolean => s.phase === 'starting' || s.phase === 'waiting';

/**
 * Calls `fn` every `ms` and hands the result to `onData`, until `active` says nothing is running or the returned
 * function is called. A failed request is skipped and tried again on the next tick.
 */
export function pollWhile(
  fn: () => Promise<ConnectionsDto>,
  active: (d: ConnectionsDto) => boolean,
  onData: (d: ConnectionsDto) => void,
  ms = 1500,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      const d = await fn();
      if (stopped) return;
      onData(d);
      if (!active(d)) return;
    } catch {
      /* try again on the next tick */
    }
    if (!stopped) timer = setTimeout(() => void tick(), ms);
  };
  timer = setTimeout(() => void tick(), ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
