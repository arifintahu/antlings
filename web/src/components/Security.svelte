<script lang="ts">
  import { startRegistration } from '@simplewebauthn/browser';
  import { onMount } from 'svelte';
  import { ApiError, del, get, patch, post } from '../lib/api.js';
  import { disablePush, enablePush, pushState, type PushState } from '../lib/push.js';
  import { app, type StatusDto } from '../lib/store.svelte.js';
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
  let status = $state<StatusDto | null>(null);
  let testMsg = $state('');
  // Bumped on every reload so one-way controls redraw with the server's value after a refused change.
  let version = $state(0);

  const WARN = new Set(['auth_failure', 'lockout', 'reset_access', 'passkey_removed', 'signout_all', 'fallback_pending']);
  const when = (t: number) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const PAGE = 8;
  let showAll = $state(false);
  const events = $derived((data?.audit ?? []).filter((a) => !onlyWarn || WARN.has(a.kind)).slice(0, 40));
  const shown = $derived(showAll ? events : events.slice(0, PAGE));
  const SECTIONS = [
    { id: 's-passkeys', label: 'Passkeys' },
    { id: 's-backup', label: 'Backup' },
    { id: 's-devices', label: 'Devices' },
    { id: 's-notify', label: 'Alerts' },
    { id: 's-server', label: 'Server' },
    { id: 's-activity', label: 'Activity' },
  ];
  let current = $state('s-passkeys');

  /** "Chrome on Windows" instead of the raw user agent string. */
  function deviceLabel(ua: string | null): string {
    if (!ua) return 'Unknown device';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
    return browser && os ? `${browser} on ${os}` : (browser ?? os ?? ua.slice(0, 80));
  }

  let lockUntil = 0;
  function jump(id: string) {
    current = id;
    lockUntil = Date.now() + 900; // the bar keeps the clicked section while the page scrolls
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rootEl?.querySelector(`#${id}`)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
  const IDLE = [1, 4, 12, 24, 72, 168];

  async function load() {
    try {
      data = await get<Data>('/api/security');
      version++;
    } catch {
      err = 'Could not load security details.';
    }
  }

  onMount(() => {
    void load();
    app.status().then((s) => (status = s)).catch(() => undefined);
    void pushState().then((s) => (push = s));
    rootEl?.querySelector<HTMLElement>('h1')?.focus();
    // Keep the section bar in step with what is on screen. The panels appear after the data loads, so look for them until all are found.
    if (typeof IntersectionObserver === 'undefined' || !rootEl) return;
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (list) => {
        for (const e of list) seen.set(e.target.id, e.isIntersecting ? 1 : 0);
        const top = SECTIONS.find((x) => seen.get(x.id));
        if (top && Date.now() > lockUntil) current = top.id;
      },
      { root: rootEl, rootMargin: '-140px 0px -55% 0px' },
    );
    const watch = setInterval(() => {
      for (const x of SECTIONS) {
        const el = rootEl?.querySelector(`#${x.id}`);
        if (el && !seen.has(x.id)) {
          seen.set(x.id, 0);
          io.observe(el);
        }
      }
      if (seen.size === SECTIONS.length) clearInterval(watch);
    }, 300);
    return () => {
      clearInterval(watch);
      io.disconnect();
    };
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
    try {
      await post('/api/auth/logout-device', { id });
    } catch {
      err = 'That device could not be signed out.';
    }
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

  async function sendTest() {
    testMsg = '';
    try {
      const r = await app.testPush();
      testMsg = r.sent > 0 ? `Sent to ${r.sent} ${r.sent === 1 ? 'device' : 'devices'}. It should arrive in a few seconds.` : 'No device is subscribed yet. Turn notifications on first.';
    } catch {
      testMsg = 'The test could not be sent.';
    }
  }

  const upFor = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.max(1, Math.floor(s / 60))} min`);

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
  <header class="sec-top">
    <div class="sec-bar">
      <button class="back" type="button" onclick={onclose}>← Back to sessions</button>
      <h1 id="sec-h" tabindex="-1">Security</h1>
    </div>
    <nav class="secnav" aria-label="Jump to a section">
      {#each SECTIONS as s (s.id)}
        <button type="button" aria-current={current === s.id ? 'true' : undefined} onclick={() => jump(s.id)}>{s.label}</button>
      {/each}
    </nav>
  </header>
  <div class="sec-wrap">
    <div class="hint err" role="alert">{err}</div>
    <div class="hint" role="status">{info}</div>

    {#if data}
      <section class="panel" id="s-passkeys" aria-labelledby="h-passkeys">
        <h2 id="h-passkeys">Passkeys</h2>
        <p class="lead">Devices that can sign in without a password.</p>
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
      </section>

      <section class="panel" id="s-backup" aria-labelledby="h-backup">
        <h2 id="h-backup">Backup sign-in</h2>
        <p class="lead">
          {data.fallback ? 'Password plus authenticator code is set up.' : 'Not set up. A password plus an authenticator code can replace a lost passkey.'}
        </p>
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
      </section>

      <section class="panel" id="s-devices" aria-labelledby="h-devices">
        <h2 id="h-devices">Signed-in devices</h2>
        <p class="lead">Browsers that are signed in right now.</p>
        {#each data.sessions as s (s.id)}
          <div class="srow">
            <div>
              <div class="t" title={s.userAgent ?? ''}>{deviceLabel(s.userAgent)}{#if s.current}<span class="tag">this device</span>{/if}</div>
              <div class="m">{s.ip} · {s.method} · last seen {when(s.lastSeenAt)}</div>
            </div>
            {#if !s.current}<button class="btn" type="button" onclick={() => signOutDevice(s.id)}>Sign out</button>{/if}
          </div>
        {/each}
        <button class="btn danger add" type="button" onclick={signOutAll}>Sign out everywhere</button>
      </section>

      <section class="panel" id="s-notify" aria-labelledby="h-notify">
        <h2 id="h-notify">Notifications and sign-in</h2>
        {#key version}
          <label class="opt"><input type="checkbox" checked={data.settings.signinAlerts} onchange={setAlerts} /> Notify me when someone signs in</label>
          <div class="opt">
            <label for="idle">Sign out after being idle for</label>
            <select id="idle" value={data.settings.idleTimeoutHours} onchange={setIdle}>
              {#each IDLE as h (h)}<option value={h}>{h < 24 ? `${h} h` : `${h / 24} d`}</option>{/each}
              {#if !IDLE.includes(data.settings.idleTimeoutHours)}<option value={data.settings.idleTimeoutHours}>{data.settings.idleTimeoutHours} h</option>{/if}
            </select>
          </div>
        {/key}
        {#if push === 'unsupported'}
          <p class="pw-hint">Push notifications need the app installed from an https address. On iPhone, add it to the home screen first.</p>
        {:else if push === 'denied'}
          <p class="pw-hint">Notifications are blocked in this browser's settings.</p>
        {:else}
          <div class="btnrow">
            <button class="btn" type="button" onclick={togglePush}>{push === 'on' ? 'Turn off push notifications' : 'Notify me when an approval is waiting'}</button>
            {#if push === 'on'}<button class="btn" type="button" onclick={sendTest}>Send a test notification</button>{/if}
          </div>
          {#if push === 'on'}<div class="hint" role="status">{testMsg}</div>{/if}
        {/if}
      </section>

      <section class="panel" id="s-server" aria-labelledby="h-server">
        <h2 id="h-server">Server status</h2>
        {#if status}
          <dl class="tiles">
            <div class="tile"><dt>Version</dt><dd>{status.version}</dd><dd class="sub">Running for {upFor(status.uptimeSec)}</dd></div>
            <div class="tile"><dt>Sessions running</dt><dd>{status.sessions.running} of {status.sessions.max} allowed</dd></div>
            <div class="tile">
              <dt>Memory</dt>
              <dd>Service {status.serviceMemoryMb} MB</dd>
              <dd class="sub">Host {status.hostMemory.freeMb} MB free of {status.hostMemory.totalMb} MB</dd>
            </div>
            <div class="tile">
              <dt>Database</dt>
              <dd>{status.database.sizeMb} MB · {status.database.events} events</dd>
              <dd class="sub">Newest {status.eventKeep} kept per session</dd>
            </div>
            <div class="tile">
              <dt>Last sign-in</dt>
              <dd>{status.lastSignin ? when(status.lastSignin.at) : 'none yet'}</dd>
              {#if status.lastSignin?.ip}<dd class="sub">{status.lastSignin.ip}</dd>{/if}
            </div>
            <div class="tile"><dt>Push devices</dt><dd>{status.pushDevices}</dd></div>
          </dl>
        {:else}
          <p class="muted">Loading…</p>
        {/if}
      </section>

      <section class="panel" id="s-activity" aria-labelledby="h-activity">
        <h2 id="h-activity">Recent activity</h2>
        <label class="opt"><input type="checkbox" bind:checked={onlyWarn} /> Show warnings only</label>
        <ol class="audit">
          {#each shown as a (a.id)}
            <li class="arow" class:warnrow={WARN.has(a.kind)}>
              <span class="what">{a.kind.replaceAll('_', ' ')}{#if WARN.has(a.kind)}<span class="flag">warning</span>{/if}</span>
              <span class="when">{when(a.at)}{a.ip ? ` · ${a.ip}` : ''}</span>
            </li>
          {:else}
            <li class="muted">Nothing to show.</li>
          {/each}
        </ol>
        {#if events.length > PAGE}
          <button class="btn add" type="button" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${events.length}`}</button>
        {/if}
      </section>
    {:else if !err}
      <p class="muted">Loading…</p>
    {/if}
  </div>
</section>
