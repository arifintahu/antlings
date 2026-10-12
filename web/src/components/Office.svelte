<script lang="ts">
  import { STATE_LABEL, type AntState } from '../ants/draw.js';
  import { counts, type AntView, type SessionView } from '../lib/model.js';
  import { app, lookOf, nameOf } from '../lib/store.svelte.js';
  import Ant from './Ant.svelte';

  let { view }: { view: SessionView } = $props();
  let expanded = $state(false);

  const n = $derived(counts(view.ants));
  const summary = $derived(
    view.ants.length
      ? `${n.run} running · ${n.wait} waiting · ${n.done} done${n.fail ? ` · ${n.fail} failed` : ''}`
      : 'no subagents',
  );

  function actText(a: AntView): string {
    if (a.state === 'tool') return a.lastTool ?? 'Working';
    const t: Partial<Record<AntState, string>> = {
      thinking: 'Thinking…',
      approval: 'Waiting for you',
      done: 'Done',
      error: 'Failed',
      idle: 'Stopped',
    };
    return t[a.state] ?? '';
  }

  function focus(key: string) {
    app.focus = key;
    if (window.matchMedia('(max-width: 899px)').matches) expanded = false;
  }
</script>

<section class="office" class:expanded aria-label="Subagents of this session">
  <div class="ohead">
    <span id="summary">{summary}</span>
    <button class="link" id="team-toggle" type="button" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
      {expanded ? 'Hide' : `Agents (${view.ants.length + 1})`}
    </button>
  </div>
  <div class="floor">
    <button
      type="button"
      class="worker"
      aria-current={app.focus === 'lead'}
      aria-label="Lead {nameOf(view.id)}: {STATE_LABEL[view.state]}"
      onclick={() => focus('lead')}
    >
      <Ant state={view.state} look={lookOf(view.id)} lead />
      <span class="nm">{nameOf(view.id)} · lead</span>
      <span class="act">{STATE_LABEL[view.state]}</span>
    </button>
    {#each view.ants as a (a.taskId)}
      <button
        type="button"
        class="worker"
        aria-current={app.focus === a.taskId}
        aria-label="{a.subagentType}: {a.description}. {STATE_LABEL[a.state]}"
        onclick={() => focus(a.taskId)}
      >
        <Ant state={a.state} look={a.look} />
        <span class="nm">{a.subagentType}</span>
        <span class="act">{actText(a)}</span>
      </button>
    {:else}
      <div class="empty">No subagents yet. The lead works alone until it delegates a task.</div>
    {/each}
  </div>
</section>
