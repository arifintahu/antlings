<script lang="ts">
  import { argOf, type SessionView } from '../lib/model.js';
  import { app, nameOf } from '../lib/store.svelte.js';
  import Chip from './Chip.svelte';

  let { view, archived }: { view: SessionView; archived: boolean } = $props();

  const pretty = (v: unknown): string => {
    try {
      return JSON.stringify(v, null, 2) ?? '';
    } catch {
      return String(v);
    }
  };
  const antOf = (taskId: string) => view.ants.find((a) => a.taskId === taskId);
  const thinking = $derived(view.turnRunning && view.state === 'thinking');
</script>

{#if archived}
  <div class="card">
    <div class="hd"><span>Archived</span></div>
    <pre>This session is archived. Unarchive it to continue.</pre>
    <div class="acts">
      <button class="btn" type="button" onclick={() => app.activeId && app.archive(app.activeId, false)}>Unarchive</button>
    </div>
  </div>
{/if}

{#each view.items as it (it.seq)}
  {#if it.kind === 'user'}
    <div class="msg user"><span class="who">You</span>{it.text}</div>
  {:else if it.kind === 'agent'}
    <div class="msg agent"><span class="who">{nameOf(view.id)}</span>{it.text}</div>
  {:else if it.kind === 'tool'}
    {@const done = !!it.result}
    <div class="card toolcard" class:bad={it.result && !it.result.ok}>
      <div class="hd"><span>{it.name} · {done ? (it.result?.ok ? 'finished' : 'failed') : 'running'}</span></div>
      <pre>{argOf(it.input) || pretty(it.input)}{it.result?.text ? `\n${it.result.text}` : ''}{#if !done}<span class="caret"></span>{/if}</pre>
    </div>
  {:else if it.kind === 'approval'}
    <div class="card" class:warn={it.status === 'waiting'} class:good={it.status === 'allowed'} class:bad={it.status === 'denied'}>
      <div class="hd">
        <span
          >{it.toolName} · {it.status === 'waiting' ? 'waiting for approval' : it.status === 'allowed' ? 'approved' : 'denied'}</span
        >
      </div>
      <pre>{it.title ? `${it.title}\n` : ''}{argOf(it.input) || pretty(it.input)}</pre>
      {#if it.status === 'waiting'}
        <div class="acts">
          <button class="btn primary" type="button" onclick={() => app.approve(it.requestId)}>Approve</button>
          <button class="btn danger" type="button" onclick={() => app.deny(it.requestId)}>Deny</button>
        </div>
      {/if}
    </div>
  {:else if it.kind === 'spawn'}
    {@const a = antOf(it.taskId)}
    {#if a}
      <button type="button" class="spawn-row" title={a.description} onclick={() => (app.focus = a.taskId)}>
        <span>→ {a.subagentType}</span><Chip state={a.state} />
      </button>
    {/if}
  {:else if it.kind === 'notice'}
    <div class="card" class:bad={it.bad}>
      <div class="hd"><span>{it.bad ? 'Problem' : 'Notice'}</span></div>
      <pre>{it.text}</pre>
    </div>
  {/if}
{/each}

{#if thinking}
  <div class="msg agent caret"><span class="who">{nameOf(view.id)}</span>Thinking…</div>
{/if}
