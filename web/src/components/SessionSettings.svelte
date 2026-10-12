<script lang="ts">
  import type { PermissionMode } from '@antlings/shared';
  import { MODES, MODE_HINT, showPath } from '../lib/options.js';
  import { app } from '../lib/store.svelte.js';

  let { open, onclose }: { open: boolean; onclose: () => void } = $props();
  let dlg: HTMLDialogElement;
  let title = $state('');

  const view = $derived(app.active);
  const mode = $derived((view?.mode as PermissionMode | undefined) ?? 'default');
  const current = $derived(app.models.find((m) => m.value === view?.model));

  $effect(() => {
    if (open && !dlg.open) {
      title = app.activeSummary?.title ?? '';
      dlg.showModal();
    } else if (!open && dlg.open) dlg.close();
  });

  async function changeMode(ev: Event) {
    const el = ev.target as HTMLSelectElement;
    const ok = await app.setMode(el.value as PermissionMode);
    // The server confirms with a settings event. Until then (or if refused) show the real mode.
    if (!ok) el.value = mode;
  }

  async function saveTitle() {
    const t = title.trim();
    if (app.activeId && t && t !== app.activeSummary?.title) await app.rename(app.activeId, t);
  }
</script>

<dialog bind:this={dlg} aria-labelledby="setdlg-h" onclose={onclose}>
  <h2 id="setdlg-h">Session settings</h2>
  <div class="field">
    <label for="set-title">Name</label>
    <input id="set-title" bind:value={title} onchange={saveTitle} />
  </div>
  <div class="field">
    <span class="lbl">Folder</span>
    <div>{showPath(app.activeSummary?.cwd ?? '')}</div>
  </div>
  <div class="field grid3">
    <div class="field">
      <label for="set-model">Model</label>
      <select id="set-model" value={view?.model} onchange={(e) => app.setModel(e.currentTarget.value)}>
        {#each app.models as m (m.value)}<option value={m.value}>{m.displayName}</option>{/each}
        {#if view?.model && !app.models.some((m) => m.value === view?.model)}<option value={view.model}>{view.model}</option>{/if}
      </select>
    </div>
    <div class="field">
      <label for="set-effort">Effort</label>
      <select id="set-effort" value={view?.effort ?? ''} disabled={!current?.supportsEffort} onchange={(e) => app.setEffort(e.currentTarget.value)}>
        <option value="" disabled>{current?.supportsEffort ? 'Default' : 'Not supported'}</option>
        {#each current?.effortLevels ?? [] as l (l)}<option value={l}>{l}</option>{/each}
      </select>
    </div>
    <div class="field">
      <label for="set-mode">Mode</label>
      <select id="set-mode" value={mode} onchange={changeMode}>
        {#each MODES as [v, l] (v)}<option value={v}>{l}</option>{/each}
      </select>
    </div>
  </div>
  <div class="hint" class:warn={mode === 'bypassPermissions'}>
    {MODE_HINT[mode]} Model and mode apply now. Effort applies from the next turn.
  </div>
  <div class="acts"><button type="button" class="btn primary" onclick={onclose}>Done</button></div>
</dialog>
