<script lang="ts">
  import { startRegistration } from '@simplewebauthn/browser';
  import { onMount } from 'svelte';
  import { ApiError, del, get, patch, post } from '../lib/api.js';
  import { disablePush, enablePush, pushState, type PushState } from '../lib/push.js';
  import { app } from '../lib/store.svelte.js';
  import Qr from './Qr.svelte';

  let { onclose }: { onclose: () => void } = $props();

  interface Data {
    passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[];
    fallback: boolean;
    sessions: { id: string; createdAt: number; lastSeenAt: number; userAgent: string | null; ip: string | null; method: string; current: boolean }[];
    audit: { id: number; at: number; kind: string; ip: string | null; detail: unknown }[];
    settings: { idleTimeoutHours: number; signinAlerts: boolean };
  }

  let data = $state<Data | null>(null);
  let err = $state('');
  let info = $state('');
  let onlyWarn = $state(false);
  let push = $state<PushState>('unsupported');
  let fbPassword = $state('');
  let fb = $state<{ secret: string; otpauthUrl: string } | null>(null);
  let fbCode = $state('');
  let fbOpen = $state(false);
  let rootEl: HTMLElement | undefined = $state();
  let deviceName = $state('');

  const WARN = new Set(['auth_failure', 'lockout', 'reset_access', 'passkey_removed', 'signout_all', 'fallback_pending']);
  const when = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const events = $derived((data?.audit ?? []).filter((a) => !onlyWarn || WARN.has(a.kind)).slice(0, 40));
  const IDLE = [1, 4, 12, 24, 72, 168];

  async function load() {
    try {
      data = await get<Data>('/api/security');
    } catch {
      err = 'Could not load security details.';
    }
  }

  onMount(() => {
    void load();
    void pushState().then((s) => (push = s));
    rootEl?.querySelector<HTMLElement>('h1')?.focus();
  });

  async function guarded<T>(reason: string, fn: () => Promise<T>): Promise<T | undefined> {
    err = '';
    info = '';
    try {
      return await app.withStepUp(reason, fn);
    } catch (e) {
      err = e instanceof ApiError && e.code === 'last_method' ? 'You cannot remove your last way to sign in.' : e instanceof ApiError && e.status === 429 ? 'Too many attempts. Wait and try again.' : 'That did not work.';
      return undefined;
    }
  }

  async function addPasskey() {
    const name = deviceName.trim() || 'New device';
    const ok = await guarded('Adding a passkey.', async () => {
      const o = await post<{ challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/api/security/passkeys/options');
      const response = await startRegistration({ optionsJSON: o.options });
      return post('/api/security/passkeys/verify', { challengeId: o.challengeId, name, response });
    });
    if (ok) {
      info = 'Passkey added.';
      await load();
    }
  }

  async function removePasskey(id: string, name: string) {
    if (!confirm(`Remove the passkey “${name}”?`)) return;
    if (await guarded('Removing a passkey.', () => del(`/api/security/passkeys/${encodeURIComponent(id)}`))) {
      info = 'Passkey removed.';
      await load();
    }
  }

  async function startFallback(ev: SubmitEvent) {
    ev.preventDefault();
    if (fbPassword.length < 12) return;
    const r = await guarded('Changing your backup password.', () => post<{ secret: string; otpauthUrl: string }>('/api/security/fallback', { password: fbPassword }));
    if (r) {
      fb = r;
      fbPassword = '';
    }
  }

  async function confirmFallback(ev: SubmitEvent) {
    ev.preventDefault();
    const ok = await guarded('Confirming your backup code.', () => post('/api/security/fallback/confirm', { code: fbCode }));
    if (ok) {
      fb = null;
      fbCode = '';
      fbOpen = false;
      info = 'Backup sign-in is ready.';
      await load();
    }
  }

  async function signOutDevice(id: string) {
    await post('/api/auth/logout-device', { id });
    await load();
  }

  async function signOutAll() {
    if (!confirm('Sign out of every device, including this one?')) return;
    if (await guarded('Signing out everywhere.', () => post('/api/auth/logout-all'))) app.signedOut();
  }

  async function setIdle(ev: Event) {
    const hours = Number((ev.target as HTMLSelectElement).value);
    if (await guarded('Changing the idle timeout.', () => patch('/api/security/settings', { idleTimeoutHours: hours }))) {
      info = 'Saved.';
      await load();
    }
  }

  async function setAlerts(ev: Event) {
    const on = (ev.target as HTMLInputElement).checked;
    await guarded('Changing sign-in alerts.', () => patch('/api/security/settings', { signinAlerts: on }));
    await load();
  }

  async function togglePush() {
    err = '';
    try {
      push = push === 'on' ? await disablePush() : await enablePush();
    } catch {
      err = 'Notifications could not be changed.';
    }
  }
</script>

<section class="sec" bind:this={rootEl} aria-labelledby="sec-h">
  <div class="sec-wrap">
    <button class="back" type="button" onclick={onclose}>← Back to sessions</button>
    <h1 id="sec-h" tabindex="-1">Security</h1>
    <div class="hint err" role="alert">{err}</div>
    <div class="hint" role="status">{info}</div>

    {#if data}
      <h2>Passkeys</h2>
      {#each data.passkeys as p (p.id)}
        <div class="srow">
          <div>
            <div class="t">{p.name}</div>
            <div class="m">Added {when(p.createdAt)} · used {p.lastUsedAt ? when(p.lastUsedAt) : 'never'}</div>
          </div>
          <button class="btn danger" type="button" onclick={() => removePasskey(p.id, p.name)}>Remove</button>
        </div>
      {:else}
        <p>No passkeys.</p>
      {/each}
      <div class="fld add">
        <label for="dev-name">Name for the new device</label>
        <div class="mkrow">
          <input id="dev-name" class="wide-input" placeholder="For example: laptop" autocomplete="off" bind:value={deviceName} />
          <button class="btn" type="button" onclick={addPasskey}>Add a passkey</button>
        </div>
      </div>

      <h2>Backup sign-in</h2>
      <p>{data.fallback ? 'Password plus authenticator code is set up.' : 'Not set up. A password plus an authenticator code can replace a lost passkey.'}</p>
      {#if !fbOpen}
        <button class="btn" type="button" onclick={() => (fbOpen = true)}>{data.fallback ? 'Replace password and code' : 'Set up password and code'}</button>
      {:else if !fb}
        <form class="fld" onsubmit={startFallback}>
          <label for="fb-pass">New password (12 characters or more)</label>
          <input id="fb-pass" class="wide-input" type="password" autocomplete="new-password" bind:value={fbPassword} />
          <button class="btn primary" type="submit" disabled={fbPassword.length < 12}>Continue</button>
        </form>
      {:else}
        <div class="qrbox">
          <Qr text={fb.otpauthUrl} />
          <span class="pw-hint">Scan it, or type this key:</span>
          <code class="secret">{fb.secret}</code>
        </div>
        <form class="fld" onsubmit={confirmFallback}>
          <label for="fb-code">Code from the app</label>
          <input id="fb-code" class="wide-input code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" bind:value={fbCode} />
          <button class="btn primary" type="submit" disabled={fbCode.length !== 6}>Confirm</button>
        </form>
      {/if}
      <p class="pw-hint">Lost access? On the server run <code>antlings reset-access</code>.</p>

      <h2>Signed-in devices</h2>
      {#each data.sessions as s (s.id)}
        <div class="srow">
          <div>
            <div class="t">{s.userAgent?.slice(0, 80) || 'Unknown device'}{#if s.current}<span class="tag">this device</span>{/if}</div>
            <div class="m">{s.ip} · {s.method} · last seen {when(s.lastSeenAt)}</div>
          </div>
          {#if !s.current}<button class="btn" type="button" onclick={() => signOutDevice(s.id)}>Sign out</button>{/if}
        </div>
      {/each}
      <button class="btn danger add" type="button" onclick={signOutAll}>Sign out everywhere</button>

      <h2>Notifications and sign-in</h2>
      <label class="opt"><input type="checkbox" checked={data.settings.signinAlerts} onchange={setAlerts} /> Notify me when someone signs in</label>
      <div class="opt">
        <label for="idle">Sign out after being idle for</label>
        <select id="idle" value={data.settings.idleTimeoutHours} onchange={setIdle}>
          {#each IDLE as h (h)}<option value={h}>{h < 24 ? `${h} h` : `${h / 24} d`}</option>{/each}
          {#if !IDLE.includes(data.settings.idleTimeoutHours)}<option value={data.settings.idleTimeoutHours}>{data.settings.idleTimeoutHours} h</option>{/if}
        </select>
      </div>
      {#if push === 'unsupported'}
        <p class="pw-hint">Push notifications need the app installed from an https address. On iPhone, add it to the home screen first.</p>
      {:else if push === 'denied'}
        <p class="pw-hint">Notifications are blocked in this browser's settings.</p>
      {:else}
        <button class="btn" type="button" onclick={togglePush}>{push === 'on' ? 'Turn off push notifications' : 'Notify me when an approval is waiting'}</button>
      {/if}

      <h2>Recent activity</h2>
      <label class="opt"><input type="checkbox" bind:checked={onlyWarn} /> Show warnings only</label>
      <div class="audit">
        {#each events as a (a.id)}
          <div class="srow" class:warnrow={WARN.has(a.kind)}>
            <div><div class="t">{a.kind.replaceAll('_', ' ')}</div><div class="m">{when(a.at)}{a.ip ? ` · ${a.ip}` : ''}</div></div>
          </div>
        {:else}
          <p>Nothing to show.</p>
        {/each}
      </div>
    {:else if !err}
      <p class="muted">Loading…</p>
    {/if}
  </div>
</section>
