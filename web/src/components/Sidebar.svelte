<script lang="ts">
  import { fmtReset, level } from '../lib/model.js';
  import { app, lookOf, nameOf } from '../lib/store.svelte.js';
  import Ant from './Ant.svelte';
  import Chip from './Chip.svelte';

  let { open, inert, onnew, onclose, onsecurity }: { open: boolean; inert: boolean; onnew: () => void; onclose: () => void; onsecurity: () => void } =
    $props();

  const archivedView = $derived(app.listView === 'archived');
  const visible = $derived(app.sessions.filter((s) => s.archived === archivedView));
  const nActive = $derived(app.sessions.filter((s) => !s.archived).length);
  const nArchived = $derived(app.sessions.length - nActive);

  const base = (p: string) => p.split('/').filter(Boolean).pop() ?? '~';

  const rows = $derived.by(() => {
    const p = app.plan;
    if (p.status !== 'ok') return [];
    return [
      p.fiveHour && { key: 'Session', label: 'Current session', sub: '5-hour window', w: p.fiveHour },
      p.sevenDay && { key: 'Week', label: 'Weekly', sub: 'all models', w: p.sevenDay },
    ].filter(Boolean) as { key: string; label: string; sub: string; w: { percent: number; resetsAt: string | null } }[];
  });

  async function pick(id: string) {
    onclose();
    await app.openSession(id);
  }
</script>

<aside class="sidebar" class:open id="sidebar" aria-label="Sessions" {inert}>
  <div class="side-head">
    <h2>Antlings</h2>
    <button class="btn primary" type="button" onclick={onnew} aria-label="New session">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>New
    </button>
  </div>
  <div class="filter">
    <div class="seg" role="tablist" aria-label="Session filter">
      <button type="button" role="tab" aria-selected={!archivedView} onclick={() => (app.listView = 'active')}>Active {nActive}</button>
      <button type="button" role="tab" aria-selected={archivedView} onclick={() => (app.listView = 'archived')}>Archived {nArchived}</button>
    </div>
  </div>
  <div class="sessions">
    {#each visible as s (s.id)}
      {@const st = app.stateOf(s.id)}
      {@const ctx = app.views[s.id]?.context?.percentage ?? 0}
      <button type="button" class="row" aria-current={s.id === app.activeId} onclick={() => pick(s.id)}>
        <Ant state={st} look={lookOf(s.id)} lead animated={false} />
        <span class="d">
          <span class="t">{s.title}</span>
          <span class="meta">
            <Chip state={st} />
            <span class="n">{base(s.cwd)}</span>
            {#if ctx >= 70}<span class="s-approval">ctx {Math.round(ctx)}%</span>{/if}
          </span>
        </span>
        <span class="sr">{nameOf(s.id)}</span>
      </button>
    {:else}
      <div class="muted sidebar-empty">{archivedView ? 'Nothing archived.' : 'No sessions yet. Press New.'}</div>
    {/each}
  </div>
  <div class="side-foot">
    <section class="usage" aria-label="Plan usage limits">
      {#each rows as r (r.key)}
        <div class="lim" title="{r.label} ({r.sub}), resets in {fmtReset(r.w.resetsAt, app.now)}">
          <span>{r.key}</span>
          <span class="bar {level(r.w.percent)}" role="img" aria-label="{r.label}: {r.w.percent} percent used"><i style:width="{r.w.percent}%"></i></span>
          <span class="lp">{Math.round(r.w.percent)}%</span>
          <span class="lr">{fmtReset(r.w.resetsAt, app.now)}</span>
        </div>
      {:else}
        <div class="muted">Plan usage unavailable</div>
      {/each}
    </section>
    <div class="foot-links">
      <button class="link" type="button" onclick={onsecurity}>Security</button>
      <button class="link" type="button" onclick={() => app.signOut()}>Sign out</button>
    </div>
  </div>
</aside>
