<script lang="ts">
  import type { TerminalInfo } from '@antlings/shared';
  import { FitAddon } from '@xterm/addon-fit';
  import { Terminal } from '@xterm/xterm';
  import '@xterm/xterm/css/xterm.css';
  import { onMount } from 'svelte';
  import { ctrlOf, TerminalConnection, type TermLink } from '../lib/terminal.js';
  import { app } from '../lib/store.svelte.js';

  interface Props {
    sessionId: string;
    terminal: TerminalInfo;
    active: boolean;
    /** The phone's sticky Ctrl key: read before each typed character, cleared after it is used. */
    ctrl: { armed: boolean };
    onstate: (link: TermLink, exitCode: number | null) => void;
  }
  let { sessionId, terminal, active, ctrl, onstate }: Props = $props();

  let host: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let conn: TerminalConnection | undefined;
  let exitCode: number | null = null;

  /** Types bytes into the shell, as the key bar does. */
  export function send(bytes: string): void {
    conn?.sendInput(bytes);
    term?.focus();
  }
  export function focus(): void {
    term?.focus();
  }

  const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const theme = () => ({
    background: css('--bg'),
    foreground: css('--fg'),
    cursor: css('--accent'),
    cursorAccent: css('--bg'),
    selectionBackground: css('--border'),
  });

  function refit(): void {
    if (!active || !host.offsetParent) return; // hidden views have no size to fit
    try {
      fit?.fit();
    } catch {
      /* not laid out yet */
    }
  }

  onMount(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    term = new Terminal({
      scrollback: 5000,
      cursorBlink: !reduced.matches,
      fontFamily: 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: window.matchMedia('(max-width: 899px)').matches ? 13 : 14,
      theme: theme(),
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.onData((d) => {
      const out = ctrl.armed ? ctrlOf(d) : d;
      if (ctrl.armed) ctrl.armed = false;
      conn?.sendInput(out);
    });
    term.onResize(({ cols, rows }) => {
      if (active) conn?.sendResize(cols, rows);
    });

    conn = new TerminalConnection({
      sessionId,
      terminalId: terminal.id,
      onMessage: (m) => {
        if (m.t === 'replay') {
          term?.reset(); // every connect replays from the start
          term?.write(m.d);
        } else if (m.t === 'out') term?.write(m.d);
        else if (m.t === 'exit') {
          exitCode = m.code;
          onstate('ended', m.code);
        }
      },
      onStatus: (s) => {
        if (s === 'open' && term && active) conn?.sendResize(term.cols, term.rows);
        if (s === 'ended') {
          onstate('ended', exitCode);
          void app.refreshTerminals(sessionId);
        } else onstate(s, null);
      },
      onSignedOut: () => void app.boot(),
      exists: async () => {
        await app.refreshTerminals(sessionId);
        return (app.terminals[sessionId] ?? []).some((t) => t.id === terminal.id);
      },
    });
    conn.start();

    const ro = new ResizeObserver(refit);
    ro.observe(host);
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const retheme = () => term && (term.options.theme = theme());
    mq.addEventListener('change', retheme);
    return () => {
      mq.removeEventListener('change', retheme);
      ro.disconnect();
      conn?.stop();
      term?.dispose();
    };
  });

  $effect(() => {
    if (active) {
      requestAnimationFrame(() => {
        refit();
        if (term) conn?.sendResize(term.cols, term.rows);
      });
    }
  });
</script>

<div class="termview" hidden={!active} bind:this={host}></div>
