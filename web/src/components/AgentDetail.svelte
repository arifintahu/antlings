<script lang="ts">
  import { fmtDur, fmtK, isBusy, type AntView } from '../lib/model.js';
  import { app } from '../lib/store.svelte.js';
  import Chip from './Chip.svelte';
  import ToolPreview from './ToolPreview.svelte';

  let { ant }: { ant: AntView } = $props();

  const running = $derived(isBusy(ant.state) || ant.state === 'approval');
  const elapsed = $derived(fmtDur((ant.endedAt ?? app.now) - ant.startedAt));
  let logEl: HTMLOListElement | undefined = $state();

  $effect(() => {
    void ant.log.length;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(ant.report ?? '');
      app.live = 'Report copied';
    } catch {
      app.banner = 'Copying is not available here.';
    }
  }
</script>

<button type="button" class="back" onclick={() => (app.focus = 'lead')}>← Conversation</button>
<div class="ahead">
  <h2>{ant.subagentType}</h2>
  <Chip state={ant.state} />
  {#if running}
    <button class="btn danger" type="button" onclick={() => app.stopTask(ant.taskId)}>Stop this agent</button>
  {/if}
</div>
<div class="ameta"><span>{ant.description}</span></div>
<div class="ameta">
  <span class="tabular">{elapsed}</span><span>{fmtK(ant.totalTokens)} tokens</span><span>{ant.toolUses || ant.log.length} tool uses</span>
</div>

<div class="card">
  <div class="hd">Activity</div>
  <ol class="log" bind:this={logEl}>
    {#each ant.log as e (e.toolUseId)}
      <li>
        <i class="dot {e.st}"></i><b>{e.name}</b><span>{e.arg}</span><span class="sr"> ({e.st})</span>
      </li>
    {:else}
      <li class="muted">Starting…</li>
    {/each}
  </ol>
</div>

{#if ant.approval && ant.approval.status === 'waiting'}
  <div class="card warn">
    <div class="hd"><span>{ant.approval.toolName} · requested by {ant.subagentType}</span></div>
    <ToolPreview name={ant.approval.toolName} input={ant.approval.input} />
    <div class="acts">
      <button class="btn primary" type="button" onclick={() => app.approve(ant.approval!.requestId)}>Approve</button>
      <button class="btn danger" type="button" onclick={() => app.deny(ant.approval!.requestId)}>Deny</button>
    </div>
  </div>
{/if}
{#if ant.state === 'done'}
  <div class="card good">
    <div class="hd"><span>Final report (returned to lead)</span></div>
    <pre>{ant.report || 'Finished.'}</pre>
    <div class="acts"><button class="btn" type="button" onclick={copy}>Copy report</button></div>
  </div>
{:else if ant.state === 'error'}
  <div class="card bad">
    <div class="hd"><span>Failed</span></div>
    <pre>{ant.report || 'The subagent failed.'}</pre>
  </div>
{:else if ant.state === 'idle'}
  <div class="card"><div class="hd"><span>Stopped</span></div><pre>Stopped before it finished.</pre></div>
{/if}
<details>
  <summary>Details</summary>
  <pre>{ant.description}</pre>
  <div class="ameta"><span>task {ant.taskId}</span><span>A follow-up goes to the lead, which resumes this agent.</span></div>
</details>
