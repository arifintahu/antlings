<script lang="ts">
  import { registerAnt } from '../ants/loop.js';
  import type { AntState } from '../ants/draw.js';

  let { state, look, lead = false, animated = true }: { state: AntState; look: number; lead?: boolean; animated?: boolean } =
    $props();
  let canvas: HTMLCanvasElement;

  $effect(() => registerAnt({ canvas, state: () => state, look: () => look, lead, animated }));
</script>

<canvas bind:this={canvas} aria-hidden="true"></canvas>
