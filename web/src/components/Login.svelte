<script lang="ts">
  import { startAuthentication } from '@simplewebauthn/browser';
  import type { AntState } from '../ants/draw.js';
  import { ApiError, post } from '../lib/api.js';
  import { app } from '../lib/store.svelte.js';
  import Ant from './Ant.svelte';

  type View = 'start' | 'wait' | 'pw' | 'code' | 'locked';
  let view = $state<View>('start');
  let ant = $state<AntState>('idle');
  let msg = $state(app.loadError);
  let isErr = $state(!!app.loadError);
  let password = $state('');
  let showPw = $state(false);
  let code = $state('');
  let pendingId = '';
  let lockedUntil = $state(0);
  let now = $state(Date.now());
  let busy = $state(false);

  $effect(() => {
    if (view !== 'locked') return;
    const t = setInterval(() => {
      now = Date.now();
      if (now >= lockedUntil) {
        view = 'start';
        ant = 'idle';
        msg = '';
      }
    }, 500);
    return () => clearInterval(t);
  });

  const mmss = (ms: number) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  function fail(e: unknown, text: string) {
    if (e instanceof ApiError && e.status === 429) {
      lockedUntil = Date.now() + (Number(e.data.retryAfterMs) || 15 * 60_000);
      now = Date.now();
      view = 'locked';
      ant = 'error';
      msg = '';
      return;
    }
    ant = 'error';
    isErr = true;
    msg = e instanceof ApiError && e.status === 0 ? 'No connection to the server.' : text;
    setTimeout(() => {
      if (ant === 'error' && view !== 'locked') ant = 'idle';
    }, 1400);
  }

  async function ok(csrf: string) {
    ant = 'done';
    isErr = false;
    msg = 'Welcome back';
    await new Promise((r) => setTimeout(r, 700));
    await app.signedIn(csrf);
  }

  async function usePasskey() {
    view = 'wait';
    ant = 'thinking';
    isErr = false;
    msg = 'Waiting for your device…';
    try {
      const o = await post<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
        '/api/auth/passkey/options',
      );
      const response = await startAuthentication({ optionsJSON: o.options });
      const r = await post<{ csrf: string }>('/api/auth/passkey/verify', { challengeId: o.challengeId, response });
      await ok(r.csrf);
    } catch (e) {
      view = 'start';
      fail(e, e instanceof ApiError ? 'That passkey was not accepted.' : 'The passkey prompt was cancelled.');
    }
  }

  async function submitPassword(ev: SubmitEvent) {
    ev.preventDefault();
    if (!password || busy) return;
    busy = true;
    ant = 'thinking';
    try {
      const r = await post<{ pendingId: string }>('/api/auth/password', { password });
      pendingId = r.pendingId;
      password = '';
      msg = '';
      ant = 'idle';
      view = 'code';
    } catch (e) {
      fail(e, 'Wrong password.');
    } finally {
      busy = false;
    }
  }

  async function submitCode(ev: SubmitEvent) {
    ev.preventDefault();
    const c = code.replace(/\D/g, '');
    if (c.length !== 6 || busy) return;
    busy = true;
    try {
      const r = await post<{ csrf: string }>('/api/auth/totp', { pendingId, code: c });
      await ok(r.csrf);
    } catch (e) {
      code = '';
      fail(e, "That code didn't match.");
    } finally {
      busy = false;
    }
  }
</script>

<section class="login" aria-labelledby="lg-title">
  <div class="login-card">
    <div class="login-ant"><Ant state={ant} look={0} lead /></div>
    <h1 id="lg-title">Antlings</h1>
    <p class="sub">Claude Code on your VPS</p>

    {#if view === 'start' || view === 'wait'}
      <button class="btn primary wide" type="button" onclick={usePasskey} disabled={view === 'wait'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v4M21 12v3" /></svg>
        Sign in with passkey
      </button>
      <button
        class="link"
        type="button"
        onclick={() => {
          view = 'pw';
          msg = '';
        }}>Use password instead</button
      >
    {:else if view === 'pw'}
      <form class="fld" onsubmit={submitPassword} novalidate>
        <div class="fld">
          <label for="lg-pass">Password</label>
          <div class="pwrow">
            <input id="lg-pass" type={showPw ? 'text' : 'password'} autocomplete="current-password" bind:value={password} />
            <button class="btn" type="button" aria-pressed={showPw} onclick={() => (showPw = !showPw)}>
              {showPw ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <button class="btn primary wide" type="submit" disabled={busy}>Continue</button>
      </form>
      <button
        class="link"
        type="button"
        onclick={() => {
          view = 'start';
          msg = '';
        }}>Use passkey instead</button
      >
    {:else if view === 'code'}
      <form class="fld" onsubmit={submitCode} novalidate>
        <div class="fld">
          <label for="lg-code">6-digit code from your authenticator app</label>
          <input
            id="lg-code"
            class="code"
            inputmode="numeric"
            pattern="[0-9]*"
            autocomplete="one-time-code"
            maxlength="6"
            bind:value={code}
          />
        </div>
        <button class="btn primary wide" type="submit" disabled={busy}>Verify</button>
      </form>
      <button
        class="link"
        type="button"
        onclick={() => {
          view = 'pw';
          msg = '';
        }}>← Back</button
      >
    {:else}
      <p class="sub big">Too many attempts</p>
      <p class="sub">Try again in <span class="tabular">{mmss(lockedUntil - now)}</span></p>
    {/if}

    <div class="lg-msg" class:err={isErr} role={isErr ? 'alert' : 'status'} aria-live="polite">{msg}</div>
    <p class="foot">Five failed attempts lock sign-in from your address for 15 minutes.</p>
  </div>
</section>
