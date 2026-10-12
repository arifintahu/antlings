<script lang="ts">
  import { buildPreview } from '../lib/preview.js';

  let { name, input }: { name: string; input: unknown } = $props();
  const p = $derived(buildPreview(name, input));
</script>

<div class="prev">
  <div class="prev-sum">{p.summary}</div>
  {#if p.lines.length}
    <pre class="prev-body" aria-label="Preview of what will run">{#each p.lines as l, i (i)}<span class="pl {l.kind}"><i class="sign" aria-hidden="true">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</i>{l.text}{'\n'}</span>{/each}</pre>
    {#if p.truncated}<div class="muted prev-more">Preview cut. The full request is run as is.</div>{/if}
  {/if}
</div>
