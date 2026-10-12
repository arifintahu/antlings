<script lang="ts">
  import type { PermissionMode } from '@antlings/shared';
  import { ApiError } from '../lib/api.js';
  import { loadLast, MODES, MODE_HINT, showPath } from '../lib/options.js';
  import { app, type FolderListing } from '../lib/store.svelte.js';

  let { open, onclose }: { open: boolean; onclose: () => void } = $props();
  let dlg: HTMLDialogElement;

  let view = $state<'form' | 'pick'>('form');
  let folder = $state('');
  let model = $state('sonnet');
  let effort = $state('');
  let mode = $state<PermissionMode>('default');
  let listing = $state<FolderListing | null>(null);
  let mk = $state(false);
  let newName = $state('');
  let nameEl: HTMLInputElement | undefined = $state();
  let err = $state('');
  let busy = $state(false);

  const current = $derived(app.models.find((m) => m.value === model));
  const recents = $derived(
    [...new Set(app.sessions.map((s) => s.cwd))].filter((p) => p !== folder && p !== '').slice(0, 3),
  );

  $effect(() => {
    if (open && !dlg.open) {
      view = 'form';
      err = '';
      // Start from what was used last time. Bypass is never preselected.
      const last = loadLast();
      folder = last?.folder ?? (app.activeSummary?.cwd || app.sessions.find((s) => s.cwd)?.cwd || '');
      model =
        app.models.find((m) => m.value === last?.model)?.value ??
        app.models.find((m) => m.value === 'sonnet')?.value ??
        app.models[0]?.value ??
        'default';
      effort = last?.effort ?? '';
      mode = last && last.mode !== 'bypassPermissions' ? last.mode : 'default';
      dlg.showModal();
    } else if (!open && dlg.open) dlg.close();
  });

  $effect(() => {
    if (current && !current.supportsEffort) effort = '';
    else if (current && effort && !current.effortLevels.includes(effort)) effort = '';
  });

  // The name field gets focus as soon as it appears.
  $effect(() => {
    if (mk && nameEl) nameEl.focus();
  });

  async function browse(path: string) {
    try {
      listing = await app.listFolders(path);
      err = '';
    } catch (e) {
      err = e instanceof ApiError ? (e.message === e.code ? 'That folder cannot be opened.' : e.message) : 'Could not list folders.';
    }
  }

  async function openPicker() {
    view = 'pick';
    mk = false;
    await browse(folder);
  }

  async function createFolder() {
    const name = newName.trim();
    if (!name || !listing) return;
    try {
      const r = await app.createFolder(listing.path, name);
      newName = '';
      mk = false;
      await browse(r.path);
    } catch (e) {
      err = e instanceof ApiError && e.code === 'exists' ? 'A folder with that name exists.' : 'Use letters, numbers, spaces, dots, dashes and underscores.';
    }
  }

  async function start() {
    busy = true;
    err = '';
    try {
      const id = await app.startSession({ folder, model, effort: effort || undefined, mode });
      if (id) onclose();
    } catch (e) {
      err = e instanceof ApiError ? (e.message === e.code ? 'The session could not be started.' : e.message) : 'The session could not be started.';
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dlg} aria-labelledby="newdlg-h" onclose={onclose}>
  {#if view === 'pick' && listing}
    <button type="button" class="back" onclick={() => (view = 'form')}>← New session</button>
    <h2 id="newdlg-h">Choose a folder</h2>
    <div class="pathline">{showPath(listing.path)}</div>
    <div class="flist">
      {#if listing.parent !== null}
        <button type="button" class="frow" onclick={() => browse(listing!.parent!)}>..</button>
      {/if}
      {#each listing.entries as f (f.name)}
        <button type="button" class="frow" onclick={() => browse(listing!.path ? `${listing!.path}/${f.name}` : f.name)}>{f.name}</button>
      {:else}
        <div class="muted sidebar-empty">No subfolders</div>
      {/each}
    </div>
    {#if mk}
      <div class="mkrow">
        <label class="sr" for="nd-name">Folder name</label>
        <input
          id="nd-name"
          placeholder="folder name"
          autocomplete="off"
          bind:this={nameEl}
          bind:value={newName}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void createFolder();
            }
          }}
        />
        <button type="button" class="btn" onclick={createFolder}>Create</button>
      </div>
    {/if}
    <div class="hint err" role="alert">{err}</div>
    <div class="acts">
      <button type="button" class="btn" onclick={() => (mk = !mk)}>New folder</button>
      <button
        type="button"
        class="btn primary"
        onclick={() => {
          folder = listing!.path;
          view = 'form';
        }}>Use this folder</button
      >
    </div>
  {:else}
    <h2 id="newdlg-h">New session</h2>
    <div class="field">
      <span class="lbl">Folder</span>
      <button type="button" class="pathbox" title={showPath(folder)} onclick={openPicker}>
        <span>{showPath(folder)}</span><span class="muted">Change</span>
      </button>
      {#if recents.length}
        <div class="recent">
          {#each recents as p (p)}
            <button type="button" onclick={() => (folder = p)} title={showPath(p)}>{showPath(p)}</button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="field grid3">
      <div class="field">
        <label for="nd-model">Model</label>
        <select id="nd-model" bind:value={model}>
          {#each app.models as m (m.value)}<option value={m.value}>{m.displayName}</option>{:else}<option value="default">Default</option>{/each}
        </select>
      </div>
      <div class="field">
        <label for="nd-effort">Effort</label>
        <select id="nd-effort" bind:value={effort} disabled={!current?.supportsEffort}>
          <option value="">{current?.supportsEffort ? 'Default' : 'Not supported'}</option>
          {#each current?.effortLevels ?? [] as l (l)}<option value={l}>{l}</option>{/each}
        </select>
      </div>
      <div class="field">
        <label for="nd-mode">Mode</label>
        <select id="nd-mode" bind:value={mode}>
          {#each MODES as [v, l] (v)}<option value={v}>{l}</option>{/each}
        </select>
      </div>
    </div>
    <div class="hint" class:warn={mode === 'bypassPermissions'}>{MODE_HINT[mode]}</div>
    <div class="hint err" role="alert">{err}</div>
    <div class="acts">
      <button type="button" class="btn" onclick={onclose}>Cancel</button>
      <button type="button" class="btn primary" onclick={start} disabled={busy}>Start</button>
    </div>
  {/if}
</dialog>
