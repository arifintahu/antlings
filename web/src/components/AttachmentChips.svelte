<script lang="ts">
  import { formatBytes } from '@antlings/shared';
  import type { TrayItem } from '../lib/attach.js';

  let { items, onremove }: { items: TrayItem[]; onremove: (key: string) => void } = $props();

  const status = (i: TrayItem): string =>
    i.state === 'uploading' ? `Uploading ${Math.round(i.progress * 100)}%` : i.state === 'ready' ? 'Ready' : 'Not attached';
</script>

<ul class="tray" aria-label="Attached files">
  {#each items as i (i.key)}
    <li class="file-chip" class:err={i.state === 'error'}>
      {#if i.state === 'error'}
        <svg class="ficon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 17v.5M3 20L12 4l9 16z" /></svg>
      {:else if i.preview}
        <img class="thumb" src={i.preview} alt="" width="32" height="32" />
      {:else}
        <svg class="ficon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4" /></svg>
      {/if}
      <span class="nm">{i.name}</span>
      <span class="sz">{formatBytes(i.size)}</span>
      <span class="st">{status(i)}</span>
      <button class="iconbtn" type="button" aria-label={`Remove ${i.name}`} onclick={() => onremove(i.key)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </li>
  {/each}
</ul>
