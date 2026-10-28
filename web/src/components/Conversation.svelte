<script lang="ts">
  import { formatBytes } from '@antlings/shared';
  import { argOf, type SessionView } from '../lib/model.js';
  import { app, nameOf } from '../lib/store.svelte.js';
  import Chip from './Chip.svelte';
  import Markdown from './Markdown.svelte';
  import ToolPreview from './ToolPreview.svelte';

  let { view, archived }: { view: SessionView; archived: boolean } = $props();

  const pretty = (v: unknown): string => {
    try {
      return JSON.stringify(v, null, 2) ?? '';
    } catch {
      return String(v);
    }
  };
  const antOf = (taskId: string) => view.ants.find((a) => a.taskId === taskId);
  const thinking = $derived(view.turnRunning && view.state !== 'approval' && !view.streaming);
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
    <div class="msg user">
      <span class="who">You</span>{it.text}
      {#if it.attachments?.length}
        <ul class="tray sent" aria-label="Attached files">
          {#each it.attachments as a (a.id)}
            <li class="chip">
              {#if a.kind === 'image'}
                <img class="thumb" src={`/api/sessions/${view.id}/uploads/${a.id}`} alt="" width="32" height="32" />
              {:else}
                <svg class="ficon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4" /></svg>
              {/if}
              <span class="nm">{a.name}</span>
              <span class="sz">{formatBytes(a.size)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if it.kind === 'agent'}
    <div class="msg agent"><span class="who">{nameOf(view.id)}</span><Markdown text={it.text} /></div>
  {:else if it.kind === 'tool'}
    {@const ap = it.approval}
    {@const waiting = ap?.status === 'waiting'}
    {@const done = !!it.result}
    <div
      class="card toolcard"
      class:warn={waiting}
      class:bad={(it.result && !it.result.ok) || ap?.status === 'denied'}
    >
      <div class="hd">
        <span
          >{it.name} · {waiting
            ? 'waiting for approval'
            : ap?.status === 'denied'
              ? 'denied'
              : done
                ? it.result?.ok
                  ? 'finished'
                  : 'failed'
                : 'running'}{ap?.status === 'allowed' ? ' · approved' : ''}</span
        >
      </div>
      {#if ap}
        <ToolPreview name={it.name} input={it.input} />
      {:else}
        <pre>{argOf(it.input) || pretty(it.input)}</pre>
      {/if}
      {#if it.result?.text}<pre class="result">{it.result.text}</pre>{/if}
      {#if waiting}
        <div class="acts">
          <button class="btn primary" type="button" onclick={() => app.approve(ap!.requestId)}>Approve</button>
          <button class="btn danger" type="button" onclick={() => app.deny(ap!.requestId)}>Deny</button>
        </div>
      {/if}
    </div>
  {:else if it.kind === 'approval'}
    <div class="card" class:warn={it.status === 'waiting'} class:good={it.status === 'allowed'} class:bad={it.status === 'denied'}>
      <div class="hd">
        <span>{it.toolName} · {it.status === 'waiting' ? 'waiting for approval' : it.status === 'allowed' ? 'approved' : 'denied'}</span>
      </div>
      <ToolPreview name={it.toolName} input={it.input} />
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

{#if view.streaming}
  <div class="msg agent streaming" aria-live="off">
    <span class="who">{nameOf(view.id)}</span><Markdown text={view.streaming} /><span class="caret"></span>
  </div>
{:else if thinking}
  <div class="msg agent caret"><span class="who">{nameOf(view.id)}</span>Thinking…</div>
{/if}
