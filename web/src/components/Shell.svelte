<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { STATE_LABEL } from '../ants/draw.js';
  import { counts, fmtK, isBusy, level } from '../lib/model.js';
  import { showPath } from '../lib/options.js';
  import { app } from '../lib/store.svelte.js';
  import AgentDetail from './AgentDetail.svelte';
  import Conversation from './Conversation.svelte';
  import NewSession from './NewSession.svelte';
  import Office from './Office.svelte';
  import Security from './Security.svelte';
  import SessionSettings from './SessionSettings.svelte';
  import Sidebar from './Sidebar.svelte';

  let drawer = $state(false);
  let menuOpen = $state(false);
  let ctxOpen = $state(false);
  let newOpen = $state(false);
  let settingsOpen = $state(false);
  let confirmDelete = $state(false);
  let deleting = $state(false);
  let prompt = $state('');
  let chatEl: HTMLElement | undefined = $state();
  let delDlg: HTMLDialogElement;
  let desktop = $state(false);

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
          ? 'Ask the agent…'
          : busyAnt
            ? `${ant.subagentType} is working…`
            : `Follow up with ${ant.subagentType} (the lead resumes it)…`,
  );

  // Keep the newest message in view unless the reader scrolled up.
  $effect(() => {
    void view?.lastSeq;
    void app.focus;
    const el = chatEl;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (near) void tick().then(() => (el.scrollTop = el.scrollHeight));
  });

  $effect(() => {
    void app.focus;
    void app.activeId;
    void tick().then(() => chatEl && (chatEl.scrollTop = app.focus === 'lead' ? chatEl.scrollHeight : 0));
  });

  function submit(ev: SubmitEvent) {
    ev.preventDefault();
    const text = prompt.trim();
    if (!text || composerOff) return;
    const sent = app.send(
      ant ? `Continue the "${ant.subagentType}" subagent ("${ant.description}") with this follow-up: ${text}` : text,
    );
    if (!sent) return; // keep the text so it is not lost
    prompt = '';
    if (ant) app.focus = 'lead';
  }

  function keydown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && window.matchMedia('(min-width: 900px)').matches) {
      ev.preventDefault();
      (ev.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
    }
  }

  function esc(ev: KeyboardEvent) {
    if (ev.key !== 'Escape') return;
    drawer = false;
    menuOpen = false;
    ctxOpen = false;
    if (app.securityOpen && !document.querySelector('dialog[open]')) app.securityOpen = false;
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

  const doneCount = $derived(app.sessions.filter((s) => !s.archived && app.stateOf(s.id) === 'done').length);
  async function archiveDone() {
    menuOpen = false;
    for (const s of app.sessions.filter((x) => !x.archived && app.stateOf(x.id) === 'done')) await app.archive(s.id, true);
  }
</script>

<svelte:window onkeydown={esc} onclick={outside} />

<div class="app" inert={app.securityOpen}>
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
  />
  <button class="scrim" class:show={drawer && !desktop} aria-label="Close sessions" tabindex="-1" onclick={() => (drawer = false)}></button>

  <div class="main">
    <header class="topbar">
      <button class="iconbtn" id="menu" type="button" aria-label="Open sessions" aria-expanded={drawer} aria-controls="sidebar" onclick={() => (drawer = true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
      <h1>
        {#if summary}{summary.title} <small title={showPath(summary.cwd)}>{showPath(summary.cwd)}</small>{:else}Antlings{/if}
      </h1>
      {#if view}
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
        <button class="iconbtn" id="sessbtn" type="button" aria-label="Session actions" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls="sessmenu"
          onclick={() => (menuOpen = !menuOpen)}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none"><rect x="3" y="10" width="4" height="4" /><rect x="10" y="10" width="4" height="4" /><rect x="17" y="10" width="4" height="4" /></svg>
        </button>
      {/if}
    </header>

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
        <div class="acts"><button class="btn" type="button" disabled={archived || composerOff} onclick={() => (app.send('/compact'), (ctxOpen = false))}>Compact</button></div>
      </div>
    {/if}

    {#if view}
      <Office {view} />
      <main class="chat" id="chat" bind:this={chatEl} aria-label={ant ? `Subagent ${ant.subagentType}` : 'Conversation'} tabindex="-1">
        {#if ant}<AgentDetail {ant} />{:else}<Conversation {view} {archived} />{/if}
        {#if !ant && view.items.length === 0}
          <div class="card"><div class="hd"><span>{STATE_LABEL[view.state]}</span></div><pre>New session. What should we work on?</pre></div>
        {/if}
      </main>
      <form class="composer" onsubmit={submit}>
        <label class="sr" for="prompt">Message</label>
        <textarea id="prompt" rows="1" {placeholder} enterkeyhint="send" disabled={composerOff} bind:value={prompt} onkeydown={keydown}></textarea>
        <button class="btn primary" type="submit" aria-label="Send" disabled={composerOff || !prompt.trim()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" /></svg>
        </button>
      </form>
    {:else}
      <main class="chat" id="chat" tabindex="-1" aria-label="Welcome">
        <div class="card">
          <div class="hd"><span>No session open</span></div>
          <pre>Pick a session on the left, or start a new one.</pre>
          <div class="acts"><button class="btn primary" type="button" onclick={() => (newOpen = true)}>New session</button></div>
        </div>
      </main>
    {/if}
  </div>
</div>

<NewSession open={newOpen} onclose={() => (newOpen = false)} />
<SessionSettings open={settingsOpen} onclose={() => (settingsOpen = false)} />
{#if app.securityOpen}<Security onclose={() => (app.securityOpen = false)} />{/if}

<dialog bind:this={delDlg} aria-labelledby="dlg-h" onclose={() => (confirmDelete = false)}>
  <h2 id="dlg-h">Delete session?</h2>
  <p>Delete “{summary?.title}”? Its transcript is removed from the server and this can't be undone. You will confirm with a passkey or code.</p>
  <div class="acts">
    <button class="btn" type="button" onclick={() => (confirmDelete = false)}>Cancel</button>
    <button class="btn danger" type="button" disabled={deleting} onclick={doDelete}>Delete</button>
  </div>
</dialog>
