<script lang="ts">
  import { app } from '../lib/store.svelte.js';

  let { open, onclose }: { open: boolean; onclose: () => void } = $props();
  let dlg: HTMLDialogElement;

  const REPO = 'https://github.com/arifintahu/antlings';

  $effect(() => {
    if (open && !dlg.open) dlg.showModal();
    else if (!open && dlg.open) dlg.close();
  });
</script>

<dialog bind:this={dlg} aria-labelledby="about-h" {onclose}>
  <h2 id="about-h">About Antlings</h2>
  <p class="about-ver">Version {app.version}</p>
  <p>Self-hosted web interface for Claude Code. A lead ant for each session and a worker ant for each subagent.</p>
  <ul class="about-links">
    <li><a href="{REPO}/releases/tag/v{app.version}" target="_blank" rel="noopener noreferrer">Release notes</a></li>
    <li><a href={REPO} target="_blank" rel="noopener noreferrer">Source code</a></li>
  </ul>
  <p class="about-lic">Released under the MIT license.</p>
  <div class="acts">
    <button class="btn" type="button" onclick={onclose}>Close</button>
  </div>
</dialog>
