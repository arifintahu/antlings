<script lang="ts">
  import { onMount } from 'svelte';
  import FirstRun from './components/FirstRun.svelte';
  import Login from './components/Login.svelte';
  import Shell from './components/Shell.svelte';
  import StepUp from './components/StepUp.svelte';
  import { app } from './lib/store.svelte.js';

  onMount(() => void app.boot());

  // Show the offline banner only after a short grace period so a quick reconnect does not flash it.
  let offline = $state(false);
  $effect(() => {
    if (app.screen !== 'app' || app.wsStatus === 'open') {
      offline = false;
      return;
    }
    const t = setTimeout(() => (offline = true), 1500);
    return () => clearTimeout(t);
  });
</script>

<a
  class="skip"
  href="/"
  onclick={(e) => {
    e.preventDefault();
    document.getElementById('chat')?.focus();
  }}>Skip to conversation</a
>

{#if offline}
  <div class="banner" role="status">
    <span>Offline. Reconnecting…</span>
    <button type="button" onclick={() => app.reconnect()}>Retry now</button>
  </div>
{/if}
{#if app.banner}
  <div class="banner err" role="alert">
    <span>{app.banner}</span>
    <button type="button" onclick={() => (app.banner = '')}>Dismiss</button>
  </div>
{/if}

{#if app.screen === 'boot'}
  <div class="screen-center" role="status"><span class="muted">Loading…</span></div>
{:else if app.screen === 'login'}
  <Login />
{:else if app.screen === 'firstrun'}
  <FirstRun />
{:else}
  <Shell />
{/if}

<StepUp />
<div class="sr" aria-live="polite">{app.live}</div>
