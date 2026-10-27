<script lang="ts">
  import { onMount } from 'svelte';
  import { keyBytes, terminalLabel, type TermKey, type TermLink } from '../lib/terminal.js';
  import { app } from '../lib/store.svelte.js';
  import TerminalView from './TerminalView.svelte';

  let { sessionId, narrow }: { sessionId: string; narrow: boolean } = $props();

  const list = $derived(app.terminals[sessionId] ?? []);
  let activeId = $state('');
  let links = $state<Record<string, { link: TermLink; code: number | null }>>({});
  const ctrl = $state({ armed: false });
  let views: Record<string, TerminalView | undefined> = {};
  let coarse = $state(false);
  let opening = $state(false);

  const current = $derived(list.find((t) => t.id === activeId) ?? list[0]);
  const showKeys = $derived(narrow || coarse);

  onMount(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const upd = () => (coarse = mq.matches);
    upd();
    mq.addEventListener('change', upd);
    return () => mq.removeEventListener('change', upd);
  });

  const labelOf = (t: (typeof list)[number]): string => {
    const l = links[t.id] ?? { link: 'connecting' as TermLink, code: null };
    const code = l.code ?? t.exitCode;
    return terminalLabel({ ...t, running: t.running && l.code === null, exitCode: code }, l.link);
  };

  async function add(): Promise<void> {
    if (opening) return;
    opening = true;
    const t = await app.openTerminal(sessionId, { cols: 80, rows: 24 });
    opening = false;
    if (t) activeId = t.id;
  }

  async function close(id: string): Promise<void> {
    const i = list.findIndex((t) => t.id === id);
    await app.closeTerminal(sessionId, id);
    delete links[id];
    delete views[id];
    if (activeId === id) activeId = (app.terminals[sessionId] ?? [])[Math.max(0, i - 1)]?.id ?? '';
  }

  function press(k: TermKey): void {
    if (current) views[current.id]?.send(keyBytes(k));
  }
</script>

<section class="termpanel" aria-label="Terminal">
  <div class="termbar">
    <div class="termtabs" role="group" aria-label="Shells">
      {#each list as t (t.id)}
        <div class="termtab" class:on={t.id === current?.id}>
          <button
            id="termtab-{t.id}"
            class="tabmain"
            type="button"
            aria-current={t.id === current?.id ? 'true' : undefined}
            onclick={() => (activeId = t.id)}
          >
            <span>{t.name}</span><small>{labelOf(t)}</small>
          </button>
          <button class="tabclose" type="button" aria-label="Close {t.name}" onclick={() => close(t.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      {/each}
    </div>
    <button class="iconbtn" type="button" aria-label="New terminal" disabled={opening} onclick={add}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </button>
  </div>

  <div class="termbody">
    {#each list as t (t.id)}
      <TerminalView
        bind:this={views[t.id]}
        {sessionId}
        terminal={t}
        active={t.id === current?.id}
        {ctrl}
        onstate={(link, code) => (links[t.id] = { link, code })}
      />
    {/each}
    {#if list.length === 0}
      <p class="termempty">No terminal is open in this session.</p>
    {/if}
  </div>

  {#if showKeys}
    <div class="keybar" role="toolbar" aria-label="Terminal keys">
      <button type="button" class="btn" onclick={() => press('esc')}>Esc</button>
      <button type="button" class="btn" onclick={() => press('tab')}>Tab</button>
      <button type="button" class="btn" aria-pressed={ctrl.armed} onclick={() => (ctrl.armed = !ctrl.armed)}>Ctrl</button>
      <button type="button" class="btn" aria-label="Control C" onclick={() => press('ctrl-c')}>^C</button>
      <button type="button" class="btn" aria-label="Up" onclick={() => press('up')}>↑</button>
      <button type="button" class="btn" aria-label="Down" onclick={() => press('down')}>↓</button>
      <button type="button" class="btn" aria-label="Left" onclick={() => press('left')}>←</button>
      <button type="button" class="btn" aria-label="Right" onclick={() => press('right')}>→</button>
    </div>
  {/if}
</section>
