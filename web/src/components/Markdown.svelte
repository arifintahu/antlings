<script lang="ts">
  import { parseMarkdown, type Inline } from '../lib/markdown.js';

  let { text }: { text: string } = $props();
  const blocks = $derived(parseMarkdown(text));
</script>

{#snippet inline(nodes: Inline[])}
  {#each nodes as n, i (i)}
    {#if n.t === 'text'}{n.v}
    {:else if n.t === 'code'}<code>{n.v}</code>
    {:else if n.t === 'strong'}<strong>{@render inline(n.v)}</strong>
    {:else if n.t === 'em'}<em>{@render inline(n.v)}</em>
    {:else if n.t === 'link'}<a href={n.href} target="_blank" rel="noopener noreferrer nofollow">{@render inline(n.v)}</a>
    {/if}
  {/each}
{/snippet}

<div class="md">
  {#each blocks as b, i (i)}
    {#if b.t === 'p'}
      <p>{@render inline(b.v)}</p>
    {:else if b.t === 'h'}
      <p class="mdh mdh{b.level}">{@render inline(b.v)}</p>
    {:else if b.t === 'code'}
      <pre class="mdcode" aria-label={b.lang ? `${b.lang} code` : 'code'}><code>{b.v}</code></pre>
    {:else if b.t === 'ul'}
      <ul>{#each b.v as item, j (j)}<li>{@render inline(item)}</li>{/each}</ul>
    {:else if b.t === 'ol'}
      <ol>{#each b.v as item, j (j)}<li>{@render inline(item)}</li>{/each}</ol>
    {:else if b.t === 'quote'}
      <blockquote>{@render inline(b.v)}</blockquote>
    {/if}
  {/each}
</div>
