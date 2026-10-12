<script lang="ts">
  import { STATE_LABEL, type AntState } from '../ants/draw.js';

  let { state }: { state: AntState } = $props();
</script>

<span class="chip s-{state}">{STATE_LABEL[state]}</span>
