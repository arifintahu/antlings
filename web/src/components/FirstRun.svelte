<script lang="ts">
  import { startRegistration } from '@simplewebauthn/browser';
  import type { AntState } from '../ants/draw.js';
  import { ApiError, post, setCsrf } from '../lib/api.js';
  import { app } from '../lib/store.svelte.js';
  import Ant from './Ant.svelte';
  import Qr from './Qr.svelte';

  type Step = 1 | 2 | 3 | 4;
  type RegOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

  let step = $state<Step>(1);
  let ant = $state<AntState>('idle');
  let msg = $state('');
  let isErr = $state(false);
  let busy = $state(false);

  let code = $state('');
  let deviceName = $state('This device');
  let challengeId = '';
  let options: RegOptions | undefined;
  let csrf = '';

  let password = $state('');
  let secret = $state('');
  let otpauth = $state('');
  let totp = $state('');

  const SUB = [
    '',
    'Step 1 of 3. Enter the setup code printed on the server.',
    'Step 2 of 3. Create your passkey.',
    'Step 3 of 3. Optional: add a password and authenticator code as a backup.',
    '',
  ];

  function problem(e: unknown, fallback: string) {
    isErr = true;
    ant = 'error';
    msg =
      e instanceof ApiError
        ? e.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : e.status === 0
            ? 'No connection to the server.'
            : fallback
        : fallback;
    setTimeout(() => ant === 'error' && (ant = 'idle'), 1400);
  }

  async function submitCode(ev: SubmitEvent) {
    ev.preventDefault();
    if (busy || !code.trim()) return;
    busy = true;
    try {
      const o = await post<{ challengeId: string; options: RegOptions }>('/api/setup/options', { code: code.trim() });
      challengeId = o.challengeId;
      options = o.options;
      msg = '';
      isErr = false;
      step = 2;
    } catch (e) {
      problem(e, 'That code is not valid or has expired. Run antlings setup again.');
    } finally {
      busy = false;
    }
  }

  async function createPasskey(ev: SubmitEvent) {
    ev.preventDefault();
    if (busy || !options) return;
    busy = true;
    ant = 'thinking';
    msg = 'Waiting for your device…';
    isErr = false;
    try {
      const response = await startRegistration({ optionsJSON: options });
      const r = await post<{ csrf: string }>('/api/setup/verify', {
        code: code.trim(),
        challengeId,
        name: deviceName.trim() || 'This device',
        response,
      });
      csrf = r.csrf;
      setCsrf(r.csrf);
      msg = '';
      ant = 'done';
      step = 3;
    } catch (e) {
      problem(e, 'The passkey was not created. Try again.');
    } finally {
      busy = false;
    }
  }

  async function submitPassword(ev: SubmitEvent) {
    ev.preventDefault();
    if (busy || password.length < 12) return;
    busy = true;
    try {
      const r = await post<{ secret: string; otpauthUrl: string }>('/api/security/fallback', { password });
      secret = r.secret;
      otpauth = r.otpauthUrl;
      password = '';
      msg = '';
      isErr = false;
    } catch (e) {
      problem(e, 'The password was not saved.');
    } finally {
      busy = false;
    }
  }

  async function confirmCode(ev: SubmitEvent) {
    ev.preventDefault();
    if (busy || totp.length !== 6) return;
    busy = true;
    try {
      await post('/api/security/fallback/confirm', { code: totp });
      step = 4;
      ant = 'done';
      msg = '';
    } catch (e) {
      totp = '';
      problem(e, "That code didn't match.");
    } finally {
      busy = false;
    }
  }

  // The first session is already signed in after step 2 (setup creates it). Both finishing and skipping go to the app.
  async function finish() {
    await app.signedIn(csrf);
  }
</script>

<section class="login" aria-labelledby="fr-title">
  <div class="login-card">
    <div class="login-ant"><Ant state={step === 4 ? 'done' : ant} look={0} lead /></div>
    <h1 id="fr-title">{step === 4 ? 'Your colony is ready' : 'Welcome to Antlings'}</h1>
    <p class="sub">{SUB[step]}</p>
    <div class="steps" aria-hidden="true">
      {#each [1, 2, 3] as n (n)}<i class:done={step > n} class:on={step === n}></i>{/each}
    </div>

    {#if step === 1}
      <form class="fld" onsubmit={submitCode} novalidate>
        <div class="fld">
          <label for="fr-code">Setup code</label>
          <input id="fr-code" class="code" autocomplete="off" autocapitalize="characters" spellcheck="false" bind:value={code} />
        </div>
        <p class="pw-hint">On the server run <code>antlings setup</code>. The code works for 15 minutes.</p>
        <button class="btn primary wide" type="submit" disabled={busy}>Continue</button>
      </form>
    {:else if step === 2}
      <form class="fld" onsubmit={createPasskey} novalidate>
        <div class="fld">
          <label for="fr-name">Name this device</label>
          <input id="fr-name" autocomplete="off" bind:value={deviceName} />
        </div>
        <button class="btn primary wide" type="submit" disabled={busy}>Create passkey</button>
      </form>
    {:else if step === 3}
      {#if !secret}
        <form class="fld" onsubmit={submitPassword} novalidate>
          <div class="fld">
            <label for="fr-pass">Backup password (12 characters or more)</label>
            <input id="fr-pass" type="password" autocomplete="new-password" minlength="12" bind:value={password} />
          </div>
          <button class="btn primary wide" type="submit" disabled={busy || password.length < 12}>Set password</button>
        </form>
        <button class="link" type="button" onclick={() => (step = 4)}>Skip. Use the passkey only.</button>
      {:else}
        <div class="qrbox">
          <Qr text={otpauth} />
          <span class="pw-hint">Scan with an authenticator app, or type this key:</span>
          <code class="secret">{secret}</code>
        </div>
        <form class="fld" onsubmit={confirmCode} novalidate>
          <div class="fld">
            <label for="fr-totp">Code from the app</label>
            <input
              id="fr-totp"
              class="code"
              inputmode="numeric"
              pattern="[0-9]*"
              autocomplete="one-time-code"
              maxlength="6"
              bind:value={totp}
            />
          </div>
          <button class="btn primary wide" type="submit" disabled={busy || totp.length !== 6}>Confirm</button>
        </form>
      {/if}
    {:else}
      <button class="btn primary wide" type="button" onclick={finish}>Open Antlings</button>
    {/if}

    <div class="lg-msg" class:err={isErr} role={isErr ? 'alert' : 'status'} aria-live="polite">{msg}</div>
  </div>
</section>
