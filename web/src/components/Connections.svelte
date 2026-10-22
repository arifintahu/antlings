<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { ApiError, del, get, post } from '../lib/api.js';
  import {
    connectionTone,
    loginActive,
    pollWhile,
    stateLabel,
    type ConnectionsDto,
    type LoginState,
  } from '../lib/connections.js';
  import { app } from '../lib/store.svelte.js';

  let { onclose }: { onclose: () => void } = $props();

  let data = $state<ConnectionsDto | null>(null);
  let err = $state('');
  let info = $state('');
  let rootEl: HTMLElement | undefined = $state();
  let stopPoll: (() => void) | undefined;

  let apiKey = $state('');
  let showKey = $state(false);
  let choice = $state<'apikey' | 'subscription'>('apikey');
  let ack = $state(false);
  let pasted = $state('');
  let gitName = $state('');
  let gitEmail = $state('');
  let now = $state(Date.now());
  const MAX_WAIT_MS = 10 * 60_000;

  const REASON: Record<string, string> = {
    busy: 'Another sign-in is already running. Cancel it or wait for it to finish.',
    too_soon: 'Wait a minute before starting another sign-in.',
    key_rejected: 'Anthropic did not accept that key. Check it and try again.',
    wrong_mode: 'Choose Claude subscription and accept the terms first.',
    ack_required: 'Tick the box to accept the terms first.',
    not_running: 'No sign-in is waiting for a code. Start one first.',
    bad_request: 'That value is not in the right format.',
    git_failed: 'The git settings could not be saved.',
  };

  function message(e: unknown): string {
    if (e instanceof ApiError) return REASON[e.code] ?? (e.status === 0 ? 'No connection to the server.' : 'That did not work.');
    return 'That did not work.';
  }

  async function guarded<T>(reason: string, fn: () => Promise<T>): Promise<T | undefined> {
    err = '';
    info = '';
    try {
      return await app.withStepUp(reason, fn);
    } catch (e) {
      err = message(e);
      return undefined;
    }
  }

  const anyActive = (d: ConnectionsDto) => loginActive(d.github.login) || loginActive(d.claude.login);

  function adopt(d: ConnectionsDto, first = false) {
    data = d;
    if (first) {
      choice = d.claude.mode;
      ack = d.claude.ackedAt !== null;
      gitName = d.github.git.name ?? '';
      gitEmail = d.github.git.email ?? '';
    }
  }

  async function load(first = false) {
    try {
      adopt(await get<ConnectionsDto>('/api/connections'), first);
    } catch {
      err = 'Could not load the connections.';
      return;
    }
    stopPoll?.();
    if (data && anyActive(data))
      stopPoll = pollWhile(() => get<ConnectionsDto>('/api/connections'), anyActive, (d) => adopt(d), 1000);
  }

  onMount(() => {
    void load(true);
    rootEl?.querySelector<HTMLElement>('h1')?.focus();
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });
  onDestroy(() => stopPoll?.());

  const post0 = (url: string, body: unknown = {}) => post<Record<string, unknown>>(url, body);

  async function act(reason: string, fn: () => Promise<unknown>, done = '') {
    if (await guarded(reason, fn)) {
      info = done;
      await load();
    }
  }

  const startGithub = () => act('Connecting GitHub.', () => post0('/api/connections/github/start'));
  const cancelGithub = () => act('Cancelling the sign-in.', () => post0('/api/connections/github/cancel'));
  function logoutGithub() {
    if (!confirm('Disconnect GitHub from this server?')) return;
    void act('Disconnecting GitHub.', () => post0('/api/connections/github/logout'), 'GitHub disconnected.');
  }
  const saveGit = (ev: SubmitEvent) => {
    ev.preventDefault();
    void act('Saving your git name and email.', () => post0('/api/connections/git-identity', { name: gitName, email: gitEmail }), 'Saved.');
  };

  async function saveKey(ev: SubmitEvent) {
    ev.preventDefault();
    const key = apiKey;
    const r = await guarded('Saving the API key.', () => post0('/api/connections/claude/apikey', { apiKey: key }));
    if (r) {
      apiKey = '';
      showKey = false;
      info = r.verified === false ? 'Saved. Anthropic could not be reached to check it.' : 'API key saved and checked.';
      await load();
    }
  }
  function removeKey() {
    if (!confirm('Remove the saved API key?')) return;
    void act('Removing the API key.', () => del('/api/connections/claude/apikey'), 'API key removed.');
  }
  async function testClaude() {
    const r = await guarded('Testing Claude.', () => post0('/api/connections/claude/test'));
    if (!r) return;
    const TEXT: Record<string, string> = {
      ok: 'Works.',
      rejected: 'Anthropic rejected the key.',
      unreachable: 'Anthropic could not be reached.',
      signed_out: 'Not signed in.',
      no_key: 'No key is set.',
    };
    info = TEXT[String(r.result)] ?? 'Done.';
  }
  const useApiKeyMode = () => act('Using the API key.', () => post0('/api/connections/claude/mode', { mode: 'apikey' }), 'Using your API key.');
  const useSubscription = () =>
    act('Using your Claude subscription.', () => post0('/api/connections/claude/mode', { mode: 'subscription', ack }), 'Using your Claude subscription.');
  const startClaude = () => act('Signing in to Claude.', () => post0('/api/connections/claude/login/start'));
  const cancelClaude = () => act('Cancelling the sign-in.', () => post0('/api/connections/claude/login/cancel'));
  async function sendCode(ev: SubmitEvent) {
    ev.preventDefault();
    const code = pasted;
    if (await guarded('Sending the code.', () => post0('/api/connections/claude/login/code', { code }))) {
      pasted = '';
      await load();
    }
  }
  function logoutClaude() {
    if (!confirm('Sign out of Claude on this server?')) return;
    void act('Signing out of Claude.', () => post0('/api/connections/claude/logout'), 'Signed out of Claude.');
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      info = 'Copied.';
    } catch {
      info = 'Copy did not work. Select the text and copy it.';
    }
  }

  /** Time left on a sign-in. The server's deadline is capped at ten minutes so a skewed clock cannot show more. */
  function left(s: LoginState): string {
    if (s.phase !== 'waiting' && s.phase !== 'starting') return '';
    const ms = Math.max(0, Math.min(s.expiresAt - now, MAX_WAIT_MS));
    const sec = Math.round(ms / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }
</script>

<section class="sec" bind:this={rootEl} aria-labelledby="conn-h">
  <header class="sec-top">
    <div class="sec-bar">
      <button class="back" type="button" onclick={onclose}>← Back to sessions</button>
      <h1 id="conn-h" tabindex="-1">Connections</h1>
    </div>
  </header>
  <div class="sec-wrap">
    <div class="hint err" role="alert">{err}</div>
    <div class="hint" role="status">{info}</div>

    {#if data}
      {@const gh = data.github}
      {@const cl = data.claude}
      <section class="panel" id="c-github" aria-labelledby="h-github">
        <h2 id="h-github">GitHub</h2>
        <p class="lead">
          <span class="cstate {connectionTone(gh.cli)}">
            {gh.cli.state === 'signed_in'
              ? `Connected as ${gh.cli.login ?? 'your account'}`
              : gh.cli.state === 'unavailable'
                ? 'GitHub command not installed on this server'
                : 'Not connected'}
          </span>
        </p>

        {#if gh.cli.state === 'unavailable'}
          <p>Install it on the server, then come back:</p>
          <code class="cmd">sudo apt-get install gh</code>
        {:else if loginActive(gh.login)}
          {#if gh.login.phase === 'waiting' && gh.login.code}
            <div class="devcode" aria-label="One-time code">{gh.login.code}</div>
            <div class="btnrow">
              <button class="btn" type="button" onclick={() => copy(gh.login.phase === 'waiting' ? (gh.login.code ?? '') : '')}>Copy code</button>
              {#if gh.login.url}<a class="btn primary" href={gh.login.url} target="_blank" rel="noopener noreferrer">Open GitHub</a>{/if}
            </div>
            <p class="pw-hint">Time left: <span class="num">{left(gh.login)}</span></p>
          {/if}
          <div class="hint" role="status" aria-live="polite">{stateLabel(gh.login, 'github')}</div>
          <button class="btn add" type="button" onclick={cancelGithub}>Cancel</button>
        {:else}
          {#if gh.login.phase === 'error'}
            <div class="hint" role="status" aria-live="polite">{stateLabel(gh.login, 'github')}</div>
            {#if gh.login.reason === 'no_url'}<code class="cmd">{data.fallbackCommands.github}</code>{/if}
          {/if}
          {#if gh.cli.state === 'signed_in'}
            <button class="btn danger add" type="button" onclick={logoutGithub}>Disconnect GitHub</button>
          {:else}
            <button class="btn primary" type="button" onclick={startGithub}>Connect GitHub</button>
          {/if}
        {/if}

        <form class="fld add" onsubmit={saveGit}>
          <label for="git-name">Name for commits</label>
          <input id="git-name" class="wide-input" autocomplete="off" bind:value={gitName} />
          <label for="git-email">Email for commits</label>
          <input id="git-email" class="wide-input" type="email" autocomplete="off" bind:value={gitEmail} />
          <button class="btn" type="submit" disabled={!gitName.trim() || !gitEmail.trim()}>Save</button>
        </form>
        <p class="pw-hint">The agent runs as the same user as this server, so it can use this GitHub login. Connect an account, or limit its access, that you are happy to share with it.</p>
      </section>

      <section class="panel" id="c-claude" aria-labelledby="h-claude">
        <h2 id="h-claude">Claude</h2>
        <p class="lead">
          <span class="cstate {cl.mode === 'apikey' ? (cl.apiKeySet || cl.envKeySet ? 'ok' : 'idle') : connectionTone(cl.cli)}">
            {cl.mode === 'apikey'
              ? cl.apiKeySet
                ? 'Using a saved API key'
                : cl.envKeySet
                  ? 'Using the key from the server settings file'
                  : 'No API key yet'
              : cl.cli.state === 'signed_in'
                ? `Signed in with your Claude subscription${cl.cli.plan ? ` (${cl.cli.plan})` : ''}`
                : 'Subscription selected, not signed in'}
          </span>
        </p>

        <div role="radiogroup" aria-label="How Claude signs in">
          <label class="opt"><input type="radio" name="cmode" value="apikey" bind:group={choice} /> API key (recommended)</label>
          <label class="opt"><input type="radio" name="cmode" value="subscription" bind:group={choice} /> Claude subscription</label>
        </div>

        {#if choice === 'apikey'}
          {#if cl.mode !== 'apikey'}
            <button class="btn primary add" type="button" onclick={useApiKeyMode}>Use the API key</button>
          {/if}
          <form class="fld add" onsubmit={saveKey}>
            <label for="api-key">{cl.apiKeySet ? 'Replace the API key' : 'Anthropic API key'}</label>
            <div class="mkrow">
              <input
                id="api-key"
                class="wide-input"
                type={showKey ? 'text' : 'password'}
                autocomplete="off"
                spellcheck="false"
                aria-describedby="api-key-help"
                bind:value={apiKey}
              />
              <button class="btn" type="button" aria-pressed={showKey} onclick={() => (showKey = !showKey)}>{showKey ? 'Hide' : 'Show'}</button>
            </div>
            <p class="pw-hint" id="api-key-help">Saved encrypted on this server and never shown again. Use a key with a spend limit.</p>
            <div class="btnrow">
              <button class="btn primary" type="submit" disabled={!apiKey.trim()}>Save key</button>
              {#if cl.apiKeySet || cl.envKeySet}<button class="btn" type="button" onclick={testClaude}>Test</button>{/if}
              {#if cl.apiKeySet}<button class="btn danger" type="button" onclick={removeKey}>Remove key</button>{/if}
            </div>
          </form>
        {:else}
          <details class="terms" open={cl.ackedAt === null}>
            <summary>Terms for using a subscription</summary>
            <p>
              Anthropic asks products built on the Agent SDK to use API keys. Using your own Claude subscription here is for one owner and personal use only, and the terms risk is yours. Read
              <a href="https://code.claude.com/docs/en/legal-and-compliance" target="_blank" rel="noopener noreferrer">Anthropic's terms</a> before you continue.
            </p>
          </details>
          <label class="opt"><input type="checkbox" bind:checked={ack} /> I have read this and accept the risk</label>
          {#if cl.mode !== 'subscription'}
            <button class="btn primary add" type="button" disabled={!ack} onclick={useSubscription}>Use my subscription</button>
          {:else if loginActive(cl.login)}
            {#if cl.login.phase === 'waiting' && cl.login.url}
              <p>Open the link, sign in, and copy the code it shows you.</p>
              <a class="btn primary" href={cl.login.url} target="_blank" rel="noopener noreferrer">Open Claude sign-in</a>
            {/if}
            {#if cl.login.phase === 'waiting' && cl.login.needsCode}
              <form class="fld add" onsubmit={sendCode}>
                <label for="claude-code">Code from Claude</label>
                <input id="claude-code" class="wide-input" autocomplete="off" spellcheck="false" bind:value={pasted} />
                <button class="btn primary" type="submit" disabled={pasted.trim().length < 4}>Send code</button>
              </form>
            {/if}
            <p class="pw-hint">Time left: <span class="num">{left(cl.login)}</span></p>
            <div class="hint" role="status" aria-live="polite">{stateLabel(cl.login, 'claude')}</div>
            <button class="btn add" type="button" onclick={cancelClaude}>Cancel</button>
          {:else}
            {#if cl.login.phase === 'error'}
              <div class="hint" role="status" aria-live="polite">{stateLabel(cl.login, 'claude')}</div>
              {#if cl.login.reason === 'no_url'}<code class="cmd">{data.fallbackCommands.claude}</code>{/if}
            {/if}
            {#if cl.cli.state === 'signed_in'}
              <button class="btn danger add" type="button" onclick={logoutClaude}>Sign out of Claude</button>
            {:else if cl.cli.state === 'unavailable'}
              <p>Claude Code is not installed on this server.</p>
            {:else}
              <button class="btn primary add" type="button" onclick={startClaude}>Sign in with Claude</button>
            {/if}
          {/if}
        {/if}
      </section>
    {:else if !err}
      <p class="muted">Loading…</p>
    {/if}
  </div>
</section>
