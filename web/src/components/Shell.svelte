<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { STATE_LABEL } from '../ants/draw.js';
  import { counts, fmtK, isBusy, level } from '../lib/model.js';
  import { MODES, prettyModel, showPath } from '../lib/options.js';
  import { ACCEPT, pastedName } from '../lib/attach.js';
  import { app, titleOf } from '../lib/store.svelte.js';
  import { AttachmentTray } from '../lib/tray.svelte.js';
  import AttachmentChips from './AttachmentChips.svelte';
  import AgentDetail from './AgentDetail.svelte';
  import Conversation from './Conversation.svelte';
  import NewSession from './NewSession.svelte';
  import Office from './Office.svelte';
  import About from './About.svelte';
  import Connections from './Connections.svelte';
  import Security from './Security.svelte';
  import SessionSettings from './SessionSettings.svelte';
  import Sidebar from './Sidebar.svelte';
  import TerminalPanel from './TerminalPanel.svelte';

  let drawer = $state(false);
  let menuOpen = $state(false);
  let ctxOpen = $state(false);
  let newOpen = $state(false);
  let settingsOpen = $state(false);
  let confirmDelete = $state(false);
  let deleting = $state(false);
  let prompt = $state('');
  const tray = new AttachmentTray();
  let fileInput: HTMLInputElement | undefined = $state();
  let dropping = $state(false);
  let dragDepth = 0;
  let chatEl: HTMLElement | undefined = $state();
  let delDlg: HTMLDialogElement;
  let desktop = $state(false);
  /** After the reader sends a message, keep the newest text in view until the answer is done or they scroll up. */
  let follow = false;
  let renaming = $state(false);
  let renameText = $state('');
  let renameEl: HTMLInputElement | undefined = $state();

  onMount(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    const upd = () => {
      desktop = mq.matches;
      if (desktop) drawer = false;
    };
    upd();
    mq.addEventListener('change', upd);
    return () => mq.removeEventListener('change', upd);
  });

  // ---- terminal panel ----
  const termOpen = $derived(!!app.activeId && !!app.termOpen[app.activeId]);
  const shells = $derived(app.runningTerminals);
  /** Width of the panel as a share of the main area, kept per browser. */
  let termFrac = $state(readFrac());
  let dragging = false;
  let bodyEl: HTMLElement | undefined = $state();

  function readFrac(): number {
    try {
      const v = Number(localStorage.getItem('antlings.termWidth'));
      return v >= 0.25 && v <= 0.7 ? v : 0.45;
    } catch {
      return 0.45;
    }
  }
  function setFrac(v: number) {
    termFrac = Math.min(0.7, Math.max(0.25, v));
    try {
      localStorage.setItem('antlings.termWidth', String(termFrac));
    } catch {
      /* private window: the width is not remembered */
    }
  }
  function drag(ev: PointerEvent) {
    if (!dragging || !bodyEl) return;
    const r = bodyEl.getBoundingClientRect();
    setFrac((r.right - ev.clientX) / r.width);
  }
  function dividerKey(ev: KeyboardEvent) {
    if (ev.key === 'ArrowLeft') setFrac(termFrac + 0.05);
    else if (ev.key === 'ArrowRight') setFrac(termFrac - 0.05);
    else return;
    ev.preventDefault();
  }
  async function toggleTerminal(open = !termOpen) {
    const id = app.activeId;
    if (!id) return;
    app.termOpen[id] = open;
    if (open && (app.terminals[id] ?? []).length === 0) {
      await app.refreshTerminals(id);
      if ((app.terminals[id] ?? []).length === 0) await app.openTerminal(id, { cols: 80, rows: 24 });
    }
  }

  const view = $derived(app.active);
  const summary = $derived(app.activeSummary);
  const ant = $derived(view && app.focus !== 'lead' ? view.ants.find((a) => a.taskId === app.focus) : undefined);
  const archived = $derived(summary?.archived ?? false);
  const n = $derived(view ? counts(view.ants) : { run: 0, wait: 0, done: 0, fail: 0 });
  const running = $derived(!!view && (isBusy(view.state) || view.turnRunning || n.run > 0));
  const ctxPct = $derived(Math.round(view?.context?.percentage ?? 0));
  const busyAnt = $derived(!!ant && (isBusy(ant.state) || ant.state === 'approval'));
  const composerOff = $derived(!view || archived || busyAnt || app.wsStatus !== 'open');

  const placeholder = $derived(
    archived
      ? 'Archived. Unarchive to continue.'
      : app.wsStatus !== 'open'
        ? 'Offline. Reconnecting…'
        : !ant
          ? desktop
            ? 'Ask the agent… (Enter sends, Shift+Enter adds a line)'
            : 'Ask the agent…'
          : busyAnt
            ? `${ant.subagentType} is working…`
            : `Follow up with ${ant.subagentType} (the lead resumes it)…`,
  );

  // Keep the newest message in view unless the reader scrolled up.
  $effect(() => {
    void view?.lastSeq;
    void view?.streaming; // follow the answer while it is written
    void app.focus;
    const el = chatEl;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (near || follow) void tick().then(() => (el.scrollTop = el.scrollHeight));
    if (view && !view.turnRunning) follow = false; // the turn is over; stop following
  });

  $effect(() => {
    void app.focus;
    void app.activeId;
    void tick().then(() => chatEl && (chatEl.scrollTop = app.focus === 'lead' ? chatEl.scrollHeight : 0));
  });

  // Files not sent belong to the session they were attached in.
  $effect(() => {
    void app.activeId;
    untrack(() => tray.reset());
  });

  // The server refused an attachment that expired: the typed text comes back so it is not lost.
  $effect(() => {
    if (!app.restoreText) return;
    prompt = app.restoreText;
    app.restoreText = '';
  });

  function addFiles(files: File[]) {
    if (!files.length || composerOff || !app.activeId) return;
    tray.add(files, app.activeId, (name) => app.say(`Attached ${name}`));
  }

  function paste(ev: ClipboardEvent) {
    const files = [...(ev.clipboardData?.files ?? [])];
    if (!files.length || composerOff) return;
    // Text that was copied with the image still pastes as text.
    if (!ev.clipboardData?.getData('text/plain')) ev.preventDefault();
    addFiles(files.map((f) => (f.type.startsWith('image/') ? new File([f], pastedName(f, new Date()), { type: f.type }) : f)));
  }

  const hasFiles = (ev: DragEvent) => !!ev.dataTransfer?.types.includes('Files');
  function dragEnter(ev: DragEvent) {
    if (!hasFiles(ev) || composerOff) return;
    ev.preventDefault();
    dragDepth += 1;
    dropping = true;
  }
  function dragOver(ev: DragEvent) {
    if (hasFiles(ev) && !composerOff) ev.preventDefault();
  }
  function dragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropping = false;
  }
  function drop(ev: DragEvent) {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    dropping = false;
    addFiles([...(ev.dataTransfer?.files ?? [])]);
  }

  function submit(ev: SubmitEvent) {
    ev.preventDefault();
    const text = prompt.trim();
    const ids = tray.ids;
    if ((!text && ids.length === 0) || composerOff || tray.busy) return;
    const body = text || 'See the attached file(s).';
    const sent = app.send(
      ant ? `Continue the "${ant.subagentType}" subagent ("${ant.description}") with this follow-up: ${body}` : text,
      ids,
    );
    if (!sent) return; // keep the text and the files so nothing is lost
    if (ant) app.lastDraft = text;
    prompt = '';
    tray.clear();
    follow = true;
    void tick().then(() => chatEl && (chatEl.scrollTop = chatEl.scrollHeight));
    if (ant) app.focus = 'lead';
  }

  function keydown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && window.matchMedia('(min-width: 900px)').matches) {
      ev.preventDefault();
      (ev.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }

  function esc(ev: KeyboardEvent) {
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !document.querySelector('dialog[open]')) {
      const ids = app.sessions.filter((s) => s.archived === (app.listView === 'archived')).map((s) => s.id);
      if (ev.key === 'n' || ev.key === 'N') {
        ev.preventDefault();
        newOpen = true;
      } else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && ids.length) {
        ev.preventDefault();
        const i = ids.indexOf(app.activeId ?? '');
        const next = ids[(i + (ev.key === 'ArrowDown' ? 1 : -1) + ids.length) % ids.length]!;
        void app.openSession(next);
      }
      return;
    }
    if (ev.key !== 'Escape') return;
    drawer = false;
    menuOpen = false;
    ctxOpen = false;
    if (app.securityOpen && !document.querySelector('dialog[open]')) app.securityOpen = false;
    if (app.connectionsOpen && !document.querySelector('dialog[open]')) app.connectionsOpen = false;
  }

  function outside(ev: MouseEvent) {
    const t = ev.target as HTMLElement;
    if (menuOpen && !t.closest('#sessmenu, #sessbtn')) menuOpen = false;
    if (ctxOpen && !t.closest('#ctxpanel, #ctxbtn')) ctxOpen = false;
  }

  $effect(() => {
    if (confirmDelete && !delDlg.open) delDlg.showModal();
    else if (!confirmDelete && delDlg.open) delDlg.close();
  });

  async function doDelete() {
    if (!app.activeId) return;
    deleting = true;
    try {
      if (await app.remove(app.activeId)) confirmDelete = false;
    } catch {
      app.banner = 'The session could not be deleted.';
    } finally {
      deleting = false;
    }
  }

  const modeLabel = $derived(MODES.find(([m]) => m === view?.mode)?.[1] ?? 'Ask');
  const modelLabel = $derived(app.models.find((m) => m.value === view?.model)?.displayName ?? prettyModel(view?.model ?? ''));
  const cost = $derived(view && view.costUsd > 0 ? `$${view.costUsd < 0.01 ? view.costUsd.toFixed(4) : view.costUsd.toFixed(2)}` : '');

  function startRename() {
    if (!summary) return;
    renameText = titleOf(summary);
    renaming = true;
    void tick().then(() => renameEl?.select());
  }
  async function finishRename(save: boolean) {
    const t = renameText.trim();
    renaming = false;
    if (save && t && app.activeId && t !== summary?.title) {
      try {
        await app.rename(app.activeId, t);
      } catch {
        app.banner = 'The session could not be renamed.';
      }
    }
  }

  const doneCount = $derived(app.sessions.filter((s) => !s.archived && app.stateOf(s.id) === 'done').length);
  async function archiveDone() {
    menuOpen = false;
    for (const s of app.sessions.filter((x) => !x.archived && app.stateOf(x.id) === 'done')) await app.archive(s.id, true);
  }
</script>

<svelte:window onkeydown={esc} onclick={outside} onpointermove={drag} onpointerup={() => (dragging = false)} />

<div class="app" inert={app.securityOpen || app.connectionsOpen}>
  <Sidebar
    open={drawer}
    inert={!desktop && !drawer}
    onnew={() => {
      drawer = false;
      newOpen = true;
    }}
    onclose={() => (drawer = false)}
    onsecurity={() => {
      drawer = false;
      app.securityOpen = true;
    }}
    onconnections={() => {
      drawer = false;
      app.connectionsOpen = true;
    }}
    onabout={() => {
      drawer = false;
      app.aboutOpen = true;
    }}
  />
  <button class="scrim" class:show={drawer && !desktop} aria-label="Close sessions" tabindex="-1" onclick={() => (drawer = false)}></button>

  <div class="main">
    <header class="topbar">
      <button class="iconbtn" id="menu" type="button" aria-label="Open sessions" aria-expanded={drawer} aria-controls="sidebar" onclick={() => (drawer = true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
      <h1>
        {#if summary && renaming}
          <input
            class="renameinput"
            aria-label="Session name"
            bind:this={renameEl}
            bind:value={renameText}
            onkeydown={(e) => {
              if (e.key === 'Enter') void finishRename(true);
              else if (e.key === 'Escape') {
                e.stopPropagation();
                void finishRename(false);
              }
            }}
            onblur={() => renaming && void finishRename(true)}
          />
        {:else if summary}
          <button class="titlebtn" type="button" aria-label="Rename {titleOf(summary)}" onclick={startRename}>{titleOf(summary)}</button>
          <small title={showPath(summary.cwd)}>{showPath(summary.cwd)}</small>
        {:else}Antlings{/if}
      </h1>
      {#if view}
        <button
          class="modebtn"
          type="button"
          aria-label="Model and mode: {modelLabel}, {modeLabel}. Open settings"
          onclick={() => (settingsOpen = true)}
          ><span class:warn-mode={view.mode === 'bypassPermissions'}>{modeLabel}</span><span class="muted"> · {modelLabel}</span></button
        >
        <button class="ctxbtn" id="ctxbtn" type="button" aria-expanded={ctxOpen} aria-controls="ctxpanel"
          aria-label="Context window: {ctxPct} percent used"
          onclick={() => (ctxOpen = !ctxOpen)}>
          <span>{ctxPct}%</span><span class="bar {level(ctxPct)}"><i style:width="{ctxPct}%"></i></span>
        </button>
        {#if running}
          <button class="iconbtn danger" type="button" aria-label="Interrupt the current turn" onclick={() => app.interrupt()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor" /></svg>
          </button>
        {/if}
        <button
          class="iconbtn termbtn"
          class:on={termOpen}
          type="button"
          aria-label="Terminal{shells ? `, ${shells} running` : ''}"
          aria-pressed={termOpen}
          onclick={() => toggleTerminal()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6l6 6-6 6M12 18h8" /></svg>
          {#if shells}<span class="dot" aria-hidden="true"></span>{/if}
        </button>
        <button class="iconbtn" id="sessbtn" type="button" aria-label="Session actions" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="sessmenu"
          onclick={() => (menuOpen = !menuOpen)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none"><rect x="3" y="10" width="4" height="4" /><rect x="10" y="10" width="4" height="4" /><rect x="17" y="10" width="4" height="4" /></svg>
        </button>
      {/if}
    </header>

    {#each app.waitingElsewhere as w (w.id)}
      <div class="waitbar" role="status">
        <button type="button" onclick={() => app.openSession(w.id)}>“{w.title}” is waiting for your approval. Open it →</button>
      </div>
    {/each}

    {#if view && menuOpen}
      <div class="menu" id="sessmenu">
        <button type="button" onclick={() => ((menuOpen = false), (settingsOpen = true))}>Settings…</button>
        {#if doneCount}<button type="button" onclick={archiveDone}>Archive all done ({doneCount})</button>{/if}
        <button type="button" onclick={() => app.activeId && ((menuOpen = false), app.archive(app.activeId, !archived))}>
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        <button class="danger" type="button" onclick={() => ((menuOpen = false), (confirmDelete = true))}>Delete…</button>
      </div>
    {/if}
    {#if view && ctxOpen}
      <div class="ctxpanel" id="ctxpanel">
        <b>Context window</b>
        <span class="muted"> {fmtK(view.context?.totalTokens ?? 0)} / {fmtK(view.context?.maxTokens ?? 0)} tokens · {ctxPct}%</span>
        <div class="stack"><i class="fill" style:width="{ctxPct}%"></i></div>
        {#if ctxPct >= 80}<div class="muted">Close to the limit. Claude compacts automatically soon.</div>{/if}
        {#if !view.context}<div class="muted">Updated after each turn.</div>{/if}
        {#if cost}<div class="muted">Cost of this session so far: {cost}</div>{/if}
        <div class="acts"><button class="btn" type="button" disabled={archived || composerOff} onclick={() => (app.send('/compact'), (ctxOpen = false))}>Compact</button></div>
      </div>
    {/if}

    {#if view}
      {#if termOpen && !desktop}
        <div class="termswitch" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected="false" onclick={() => toggleTerminal(false)}>Chat</button>
          <button type="button" role="tab" aria-selected="true">Terminal</button>
        </div>
      {/if}
      <div class="body" bind:this={bodyEl}>
      <!-- A drop target has no keyboard role; the paperclip button is the keyboard way to attach. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="col" hidden={termOpen && !desktop} ondragenter={dragEnter} ondragover={dragOver} ondragleave={dragLeave} ondrop={drop}>
      {#if dropping}<div class="dropzone" aria-hidden="true">Drop to attach</div>{/if}
      <Office {view} />
      <main class="chat" id="chat" bind:this={chatEl} aria-label={ant ? `Subagent ${ant.subagentType}` : 'Conversation'} tabindex="-1" onscroll={() => { if (chatEl && chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight > 200) follow = false; }}>
        {#if ant}<AgentDetail {ant} />{:else}<Conversation {view} {archived} />{/if}
        {#if !ant && view.items.length === 0}
          <div class="card"><div class="hd"><span>{STATE_LABEL[view.state]}</span></div><pre>New session. What should we work on?</pre></div>
        {/if}
      </main>
      <form class="composer" onsubmit={submit}>
        {#if tray.items.length}<AttachmentChips items={tray.items} onremove={(k) => tray.remove(k)} />{/if}
        {#if tray.error}<p class="attach-err" role="alert">{tray.error}</p>{/if}
        <input bind:this={fileInput} type="file" multiple hidden accept={ACCEPT} onchange={(e) => { addFiles([...(e.currentTarget.files ?? [])]); e.currentTarget.value = ''; }} />
        <button class="btn" type="button" aria-label="Attach file" disabled={composerOff} onclick={() => fileInput?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11l-8 8a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8-8" /></svg>
        </button>
        <label class="sr" for="prompt">Message</label>
        <textarea id="prompt" rows="1" {placeholder} enterkeyhint="send" disabled={composerOff} bind:value={prompt} onkeydown={keydown} onpaste={paste}></textarea>
        <button class="btn primary" type="submit" aria-label="Send" disabled={composerOff || tray.busy || (!prompt.trim() && tray.ready.length === 0)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" /></svg>
        </button>
      </form>
      </div>
      {#if termOpen}
        {#if desktop}
          <!-- A window splitter is focusable and takes arrow keys, which Svelte does not know for role=separator. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div
            class="divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize terminal"
            aria-valuemin="25"
            aria-valuemax="70"
            aria-valuenow={Math.round(termFrac * 100)}
            tabindex="0"
            onpointerdown={(e) => {
              dragging = true;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onkeydown={dividerKey}
          ></div>
        {/if}
        <div class="termside" style:width={desktop ? `${termFrac * 100}%` : '100%'}>
          {#key app.activeId}<TerminalPanel sessionId={app.activeId!} narrow={!desktop} />{/key}
        </div>
      {/if}
      </div>
    {:else}
      <main class="chat" id="chat" tabindex="-1" aria-label="Welcome">
        <div class="card">
          <div class="hd"><span>No session open</span></div>
          <pre>Pick a session on the left, or start a new one.</pre>
          <div class="acts"><button class="btn primary" type="button" onclick={() => (newOpen = true)}>New session</button></div>
        </div>
        <div class="card">
          <div class="hd"><span>How it works</span></div>
          <div class="howto">
            <p><b>Ask</b> asks before it edits files or runs commands. <b>Accept edits</b> edits without asking. <b>Plan</b> explores and writes a plan, no edits. <b>Bypass</b> runs everything, and needs your passkey first.</p>
            <p>Start in a folder for one project, for example <code>~/my-app</code>. A session in your home folder reaches everything in it, so Antlings checks your passkey first.</p>
            <p>Each subagent shows up as a worker ant. Tap one to see what it did. Approvals can reach your phone if you turn on notifications on the Security page.</p>
          </div>
        </div>
      </main>
    {/if}
  </div>
</div>

<NewSession open={newOpen} onclose={() => (newOpen = false)} />
<SessionSettings open={settingsOpen} onclose={() => (settingsOpen = false)} />
<About open={app.aboutOpen} onclose={() => (app.aboutOpen = false)} />
{#if app.securityOpen}<Security onclose={() => (app.securityOpen = false)} />{/if}
{#if app.connectionsOpen}<Connections
    onclose={() => {
      app.connectionsOpen = false;
      void app.refreshConnections();
    }}
  />{/if}

<dialog bind:this={delDlg} aria-labelledby="dlg-h" onclose={() => (confirmDelete = false)}>
  <h2 id="dlg-h">Delete session?</h2>
  <p>Delete “{summary?.title}”? Its transcript is removed from the server and this can't be undone. You will confirm with a passkey or code.</p>
  <div class="acts">
    <button class="btn" type="button" onclick={() => (confirmDelete = false)}>Cancel</button>
    <button class="btn danger" type="button" disabled={deleting} onclick={doDelete}>Delete</button>
  </div>
</dialog>
