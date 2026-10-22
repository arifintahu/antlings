<script lang="ts">
  import type { SessionSummary } from '@antlings/shared';
  import { fmtReset, level } from '../lib/model.js';
  import { showPath } from '../lib/options.js';
  import { app, lookOf, nameOf, titleOf } from '../lib/store.svelte.js';
  import Ant from './Ant.svelte';
  import Chip from './Chip.svelte';

  let {
    open,
    inert,
    onnew,
    onclose,
    onsecurity,
    onconnections,
  }: {
    open: boolean;
    inert: boolean;
    onnew: () => void;
    onclose: () => void;
    onsecurity: () => void;
    onconnections: () => void;
  } = $props();

  const archivedView = $derived(app.listView === 'archived');
  const nActive = $derived(app.sessions.filter((s) => !s.archived).length);
  const nArchived = $derived(app.sessions.length - nActive);

  const visible = $derived.by(() => {
    const q = app.search.trim().toLowerCase();
    return app.sessions.filter(
      (s) => s.archived === archivedView && (!q || titleOf(s).toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)),
    );
  });
  const pinned = $derived(visible.filter((s) => s.pinned));
  /** Sessions grouped by project folder. The group with the newest session comes first. */
  const groups = $derived.by(() => {
    const by = new Map<string, SessionSummary[]>();
    for (const s of visible.filter((x) => !x.pinned)) {
      const list = by.get(s.cwd) ?? [];
      list.push(s);
      by.set(s.cwd, list);
    }
    return [...by.entries()].sort((a, b) => Math.max(...b[1].map((s) => s.lastModified)) - Math.max(...a[1].map((s) => s.lastModified)));
  });

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

{#snippet row(s: SessionSummary)}
  {@const st = app.stateOf(s.id)}
  {@const ctx = app.views[s.id]?.context?.percentage ?? 0}
  <div class="rowwrap">
    <button type="button" class="row" aria-current={s.id === app.activeId} onclick={() => pick(s.id)}>
      <Ant state={st} look={lookOf(s.id)} lead animated={false} />
      <span class="d">
        <span class="t">{titleOf(s)}</span>
        <span class="meta">
          <Chip state={st} />
          {#if ctx >= 70}<span class="s-approval">ctx {Math.round(ctx)}%</span>{/if}
        </span>
      </span>
      <span class="sr">{nameOf(s.id)}, {showPath(s.cwd)}</span>
    </button>
    <button
      type="button"
      class="iconbtn pinbtn"
      aria-pressed={s.pinned}
      aria-label={s.pinned ? `Unpin ${titleOf(s)}` : `Pin ${titleOf(s)}`}
      onclick={() => app.pin(s.id, !s.pinned)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" class:on={s.pinned}><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 15v5" /></svg>
    </button>
  </div>
{/snippet}

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
  {#if app.sessions.length > 3}
    <div class="searchrow">
      <label class="sr" for="session-search">Search sessions</label>
      <input id="session-search" type="search" placeholder="Search sessions" autocomplete="off" bind:value={app.search} />
    </div>
  {/if}
  <div class="sessions">
    {#if pinned.length}
      <div class="grp">Pinned</div>
      {#each pinned as s (s.id)}{@render row(s)}{/each}
    {/if}
    {#each groups as [cwd, list] (cwd)}
      <div class="grp">{showPath(cwd)}</div>
      {#each list as s (s.id)}{@render row(s)}{/each}
    {:else}
      {#if !pinned.length}
        <div class="muted sidebar-empty">
          {app.search ? 'No session matches.' : archivedView ? 'Nothing archived.' : 'No sessions yet. Press New.'}
        </div>
      {/if}
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
        <div class="muted">Plan usage shows after your first message.</div>
      {/each}
    </section>
    <div class="foot-links">
      <button class="link" type="button" onclick={onconnections}>Connections</button>
      <button class="link" type="button" onclick={onsecurity}>Security</button>
      <button class="link" type="button" onclick={() => app.signOut()}>Sign out</button>
    </div>
  </div>
</aside>
