<script lang="ts">
  import { startAuthentication } from '@simplewebauthn/browser';
  import { ApiError, post } from '../lib/api.js';
  import { app } from '../lib/store.svelte.js';

  let dlg: HTMLDialogElement;
  let busy = $state(false);
  let err = $state('');
  let code = $state('');

  $effect(() => {
    if (app.stepUpAsk && !dlg.open) {
      err = '';
      code = '';
      busy = false;
      dlg.showModal();
    }
  });

  function finish(ok: boolean) {
    if (dlg.open) dlg.close();
    app.stepUpDone(ok);
  }

  async function usePasskey() {
    busy = true;
    err = '';
    try {
      const o = await post<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
        '/api/auth/stepup/passkey/options',
      );
      const response = await startAuthentication({ optionsJSON: o.options });
      await post('/api/auth/stepup/passkey/verify', { challengeId: o.challengeId, response });
      finish(true);
    } catch (e) {
      err = e instanceof ApiError && e.status === 429 ? 'Too many attempts. Wait and try again.' : 'That did not work. Try again or use your code.';
    } finally {
      busy = false;
    }
  }

  async function useCode(ev: SubmitEvent) {
    ev.preventDefault();
    const c = code.replace(/\D/g, '');
    if (c.length !== 6) return;
    busy = true;
    err = '';
    try {
      await post('/api/auth/stepup/totp', { code: c });
      finish(true);
    } catch (e) {
      code = '';
      err = e instanceof ApiError && e.status === 429 ? 'Too many attempts. Wait and try again.' : "That code didn't match.";
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dlg} aria-labelledby="step-h" onclose={() => app.stepUpAsk && finish(false)}>
  <h2 id="step-h">Confirm it's you</h2>
  <p class="muted">{app.stepUpAsk?.reason ?? ''}</p>
  <button class="btn primary wide" type="button" onclick={usePasskey} disabled={busy}>
    {busy ? 'Waiting for your device…' : 'Use passkey'}
  </button>
  <form onsubmit={useCode}>
    <div class="field">
      <label for="step-code">Or enter your 6-digit code</label>
      <div class="mkrow">
        <input
          id="step-code"
          class="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]*"
          maxlength="6"
          bind:value={code}
        />
        <button class="btn" type="submit" disabled={busy}>Confirm</button>
      </div>
    </div>
  </form>
  <div class="hint err" role="alert">{err}</div>
  <div class="acts"><button class="btn" type="button" onclick={() => finish(false)}>Cancel</button></div>
</dialog>
